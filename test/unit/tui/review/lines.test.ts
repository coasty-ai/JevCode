import { describe, expect, it } from 'vitest';
import { RISK_DIMENSIONS, type ConfirmRequest } from '../../../../src/core/types.js';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';
import { fillRung } from '../../../../src/tui/fit.js';
import { buildBindings } from '../../../../src/tui/keys/bindings.js';
import {
  REVIEW_KEYS_DEFAULT_FILL,
  REVIEW_KEYS_RUNGS,
  SR_DIFF_ROWS,
  closeTitleQuote,
  reviewCardLines,
  reviewCardTitle,
  reviewDiffLines,
  reviewDiffScreenReaderLines,
  reviewDiffTail,
  reviewKeyFill,
  reviewKeys,
  reviewPreviewWant,
  spokenCode,
  spokenPath,
} from '../../../../src/tui/review/lines.js';
import {
  FOLLOWUP_NOTE,
  FOLLOWUP_TITLE,
  MATCHES_INTENT_NOT_JUDGED,
  REVIEW_KEYS_120,
  REVIEW_KEYS_80,
  REVIEW_PENDING_TOAST,
  SR_REVIEW_CHOICES,
  SR_REVIEW_PROMPT,
  compactRows,
  dominantDimension,
  followupLines,
  previewTail,
  reviewAriaLabel,
  reviewDigit,
  reviewHeaderLines,
  reviewPreviewLines,
  reviewRowForDigit,
  reviewRuler,
  reviewScreenReaderLines,
  reviewTitle,
  usd2,
} from '../../../../src/tui/review/lines.js';
import { mkConfirmRequest } from '../../../fixtures/tui/fixtures.js';
import { dim, workedRequest } from '../pane/helpers.js';

const req = workedRequest();
const ASCII_RE = /^[\x20-\x7e]*$/;

describe('reviewHeaderLines(req, n, columns) — the ladder (TUI-DESIGN §6.1, §19.1)', () => {
  it.each([2, 3, 4, 5, 6, 7, 8])('n=%d at 80 and 120: ≤ n rows, every row ≤ columns', (n) => {
    for (const columns of [80, 120]) {
      const lines = reviewHeaderLines(req, n, columns);
      expect(lines.length).toBeLessThanOrEqual(n);
      expect(lines.length).toBeGreaterThanOrEqual(Math.min(n, 2));
      for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(columns);
    }
  });
  it('n=8 is the full header: title, keys, ruler, four gauges in RISK_DIMENSIONS order with fixed digits, matches_intent', () => {
    const lines = reviewHeaderLines(req, 8, 80);
    expect(lines.length).toBe(8);
    expect(lines[0]).toBe('review  step 7  risk 0.44 (tail)  edit src/a.py +1 −1 "make parse_date timezon…"');
    expect(lines[1]).toBe(REVIEW_KEYS_80);
    expect(lines[2]).toBe("dimension        lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)");
    RISK_DIMENSIONS.forEach((d, i) => expect(lines[3 + i]!.startsWith(`${i + 1} ${d}`)).toBe(true));
    expect(lines[3]).toBe('1 destructive    L1  ██▌·······  0.25 exp  0.93  changes files whose previous c…');
    expect(lines[5]).toBe('3 plan_mismatch  L2  ████▍·····  0.44 tail 0.61  skips a planned verification s…');
    expect(lines[7]!.startsWith('5 matches_intent     ████████▊·  0.88 noul 0.76~ ')).toBe(true);
    // the `┆` band marks sit in bar cells 3 and 7
    const barStart = lines[3]!.indexOf('██▌');
    expect([...lines[2]!][barStart + 3]).toBe('┆');
    expect([...lines[2]!][barStart + 7]).toBe('┆');
  });
  it('n=7 drops the ruler, n=6 drops matches_intent too', () => {
    const seven = reviewHeaderLines(req, 7, 80);
    expect(seven.length).toBe(7);
    expect(seven.some((l) => l.startsWith('dimension'))).toBe(false);
    expect(seven[6]!.startsWith('5 matches_intent')).toBe(true);
    const six = reviewHeaderLines(req, 6, 80);
    expect(six.length).toBe(6);
    expect(six.some((l) => l.includes('matches_intent'))).toBe(false);
    expect(six[5]!.startsWith('4 irreversible')).toBe(true);
  });
  it('n=5..3: title, keys, n − 2 compact rows with two dimensions each at 80, the maximum-risk dimension first (F-I)', () => {
    const five = reviewHeaderLines(req, 5, 80);
    expect(five.length).toBe(5);
    expect(five[2]).toBe('3 plan_mismatch L2 r=0.44 tail c=0.61 | 1 destructive L1 r=0.25 exp c=0.93');
    expect(five[3]).toBe('5 matches_intent p=0.88 noul c=0.76~ | 2 out_of_scope L0 r=0.00 tail c=0.98');
    expect(five[4]).toBe('4 irreversible L0 r=0.00 exp c=0.96');
    expect(reviewHeaderLines(req, 4, 80).length).toBe(4);
    expect(reviewHeaderLines(req, 3, 80)).toEqual([five[0], five[1], five[2]]);
  });
  it('at ≥ 120 columns a compact row carries three dimensions, matches_intent as the third (F-X)', () => {
    const lines = reviewHeaderLines(req, 3, 120);
    expect(lines[2]).toBe('3 plan_mismatch L2 r=0.44 tail c=0.61 | 1 destructive L1 r=0.25 exp c=0.93 | 5 matches_intent p=0.88 noul c=0.76~');
    const five = reviewHeaderLines(req, 5, 120);
    expect(five.length).toBe(4);
    expect(five[3]).toBe('2 out_of_scope L0 r=0.00 tail c=0.98 | 4 irreversible L0 r=0.00 exp c=0.96');
  });
  it('digits stay fixed when the risk order changes', () => {
    const swapped = workedRequest({ risk: { ...req.risk, dims: { ...req.risk.dims, destructive: dim(3, 0.8, 0.7, 0.6, 0.8, 'tail', 0.9), plan_mismatch: dim(0, 0.05, 0.9, 0.02, 0.05, 'tail', 0.9) }, risk: 0.8, verdict: 'block' } });
    const compact = compactRows(swapped, 3, 80);
    expect(compact[0]!.startsWith('1 destructive L3 r=0.80 tail c=0.90 | ')).toBe(true);
    const full = reviewHeaderLines(swapped, 8, 80);
    expect(full[3]!.startsWith('1 destructive')).toBe(true);
    expect(full[5]!.startsWith('3 plan_mismatch')).toBe(true);
    expect(full[0]).toBe('review  step 7  risk 0.80 (tail)  edit src/a.py +1 −1 "make parse_date timezon…"');
    expect(dominantDimension(swapped)).toBe('destructive');
  });
  it('n ≤ 2: title, keys; n = 1: title; n ≤ 0 / NaN / columns 0 → []', () => {
    expect(reviewHeaderLines(req, 2, 80)).toEqual([reviewTitle(req, 80), REVIEW_KEYS_80]);
    expect(reviewHeaderLines(req, 1, 80)).toEqual([reviewTitle(req, 80)]);
    expect(reviewHeaderLines(req, 0, 80)).toEqual([]);
    expect(reviewHeaderLines(req, -1, 80)).toEqual([]);
    expect(reviewHeaderLines(req, Number.NaN, 80)).toEqual([]);
    expect(reviewHeaderLines(req, 8, 0)).toEqual([]);
    expect(reviewHeaderLines(req, 8, Number.NaN)).toEqual([]);
    expect(reviewHeaderLines(req, 20, 80).length).toBe(8);
    expect(reviewHeaderLines(req, 8.9, 80).length).toBe(8);
  });
});

describe('title, keys, ruler at 120 columns (§6.1, §24 "Review box")', () => {
  it('the 120 title adds `(tail on plan_mismatch)`, the full goal and a right-aligned `jev 244ms`', () => {
    const t = reviewTitle(req, 120);
    expect(t).toBe('review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py +1 −1  "make parse_date timezone-aware"       jev 244ms');
    expect(cellWidth(t)).toBe(120);
    const noJev = workedRequest();
    delete noJev.jevLatencyMs;
    expect(reviewTitle(noJev, 120)).toBe('review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py +1 −1  "make parse_date timezone-aware"');
  });
  it('keys and ruler are the §24 strings', () => {
    expect(reviewHeaderLines(req, 8, 120)[1]).toBe(REVIEW_KEYS_120);
    expect(reviewHeaderLines(req, 8, 120)[2]).toBe("dimension        lvl 0  ┆   ┆ 1  risk  bnd   P(l)  E[k]  tail  conf   Jev's dominant level (why); E[k]/4; tail = P(k≥3)");
    expect(REVIEW_PENDING_TOAST).toBe('review pending: y n d e w · Esc declines');
    expect(reviewRuler(80).length).toBeLessThanOrEqual(80);
  });
  it('gauge rows gain P(l) E[k] tail; matches_intent shows — for them', () => {
    const lines = reviewHeaderLines(req, 8, 120);
    expect(lines[3]!.startsWith('1 destructive    L1  ██▌·······  0.25  exp   0.90  0.25  0.00  0.93   changes files whose previous content is recoverab')).toBe(true);
    expect(lines[5]).toBe('3 plan_mismatch  L2  ████▍·····  0.44  tail  0.61  0.35  0.44  0.61   skips a planned verification step');
    expect(lines[7]!.startsWith('5 matches_intent     ████████▊·  0.88  noul  —     —     —     0.76~  ')).toBe(true);
    // the number columns line up under the ruler
    const ruler = lines[2]!;
    expect(lines[5]!.indexOf('0.44  tail')).toBe(ruler.indexOf('risk  bnd'));
    expect(lines[5]!.indexOf('0.61  0.35  0.44')).toBe(ruler.indexOf('P(l)  E[k]  tail'));
  });
});

describe('matches_intent (§15 item 6: spread in only when not null)', () => {
  it('renders the §24 not-judged row and leaves the compact rows', () => {
    const none = workedRequest();
    delete none.matchesIntent;
    expect(reviewHeaderLines(none, 8, 80)[7]).toBe(MATCHES_INTENT_NOT_JUDGED);
    expect(reviewHeaderLines(workedRequest({ matchesIntent: null }), 8, 80)[7]).toBe(MATCHES_INTENT_NOT_JUDGED);
    expect(compactRows(none, 3, 80).join('\n')).not.toContain('matches_intent');
    expect(reviewHeaderLines(none, 5, 80).length).toBe(4);
    expect(reviewAriaLabel(none, 'matches_intent')).toBe('matches_intent not judged this step');
  });
  it('a low matches_intent sorts first among the compact rows (1 − p is the concern)', () => {
    const low = workedRequest({ matchesIntent: 0.1 });
    expect(compactRows(low, 1, 80)[0]!.startsWith('5 matches_intent p=0.10 noul c=0.80~ | 3 plan_mismatch')).toBe(true);
  });
});

describe('robustness: goal, target, geometry, unicode', () => {
  it('clips a huge goal and a huge target and keeps every row ≤ columns', () => {
    const huge = workedRequest();
    huge.proposal = { ...huge.proposal, goal: 'g'.repeat(10_000), action: { kind: 'run', command: 'x'.repeat(5_000) } };
    for (const columns of [80, 120]) for (const l of reviewHeaderLines(huge, 8, columns)) expect(cellWidth(l)).toBeLessThanOrEqual(columns);
    expect(reviewTitle(huge, 80)).toContain('…"');
  });
  it('wide characters in the goal never push a row past columns', () => {
    const cjk = workedRequest();
    cjk.proposal = { ...cjk.proposal, goal: '日本語のゴールをここに書きます。とても長いテキストです。'.repeat(3) };
    for (const columns of [40, 80, 120]) for (const l of reviewHeaderLines(cjk, 8, columns)) expect(cellWidth(l)).toBeLessThanOrEqual(columns);
    expect(cellWidth(reviewTitle(cjk, 120))).toBeLessThanOrEqual(120);
  });
  it('tiny columns still yield rows and never a wider one', () => {
    for (const columns of [1, 5, 20, 40, 60]) {
      for (let n = 1; n <= 8; n++) for (const l of reviewHeaderLines(req, n, columns)) expect(cellWidth(l)).toBeLessThanOrEqual(columns);
    }
    expect(reviewHeaderLines(req, 8, 1).every((l) => l.length <= 1)).toBe(true);
  });
  it('a goal with line breaks and controls renders on one line', () => {
    const evil = workedRequest();
    evil.proposal = { ...evil.proposal, goal: 'a\nb\u001b[2Jc' };
    expect(reviewTitle(evil, 80)).toContain('"a ⏎ b[2Jc"');
  });
  it('NaN / Infinity risk numbers do not throw', () => {
    const bad = workedRequest({ risk: { ...req.risk, risk: Number.NaN, dims: { ...req.risk.dims, destructive: dim(9, Number.NaN, Number.POSITIVE_INFINITY, -1, 2, 'tail', Number.NaN) } } });
    for (const columns of [80, 120]) for (const l of reviewHeaderLines(bad, 8, columns)) expect(cellWidth(l)).toBeLessThanOrEqual(columns);
    expect(reviewHeaderLines(bad, 8, 80)[3]).toContain('1 destructive');
  });
  it('digits map both ways', () => {
    expect(RISK_DIMENSIONS.map(reviewDigit)).toEqual([1, 2, 3, 4]);
    expect(reviewDigit('matches_intent')).toBe(5);
    expect([1, 2, 3, 4, 5, 6, 0].map(reviewRowForDigit)).toEqual([...RISK_DIMENSIONS, 'matches_intent', null, null]);
  });
  it('works on the plain fixture request', () => {
    const plain = mkConfirmRequest();
    for (let n = 1; n <= 8; n++) for (const columns of [80, 120]) for (const l of reviewHeaderLines(plain, n, columns)) expect(cellWidth(l)).toBeLessThanOrEqual(columns);
    expect(reviewHeaderLines(plain, 8, 80)[7]).toBe(MATCHES_INTENT_NOT_JUDGED);
  });
});

describe('twins (§6.5, §14.1)', () => {
  it('the ascii twin is pure ASCII for ASCII input', () => {
    for (const columns of [80, 120]) for (const l of reviewHeaderLines(req, 8, columns, GLYPHS.ascii)) expect(l).toMatch(ASCII_RE);
    expect(reviewHeaderLines(req, 8, 80, GLYPHS.ascii)[5]).toBe('3 plan_mismatch  L2  ####3-----  0.44 tail 0.61  skips a planned verification...');
    expect(reviewHeaderLines(workedRequest({ matchesIntent: null }), 8, 80, GLYPHS.ascii)[7]).toBe('5 matches_intent  -  not judged this step');
  });
  it('the screen-reader twin has no ruler and no bars, aria labels per dimension and the §24 selection rows', () => {
    const sr = reviewScreenReaderLines(req);
    // TUI-DESIGN-4 §6.10: the spoken change (a `change:` sentence, a `file 1 of 1` sentence and the changed lines)
    // sits between the aria rows and the two selection rows — an SR user used to be read NOTHING of the change
    expect(sr.length).toBe(12);
    expect(sr[0]).toBe(reviewTitle(req, 80));
    expect(sr.some((l) => l.startsWith('dimension'))).toBe(false);
    for (const l of sr) expect(l).not.toMatch(/[█▏▎▍▌▋▊▉·┆]/);
    expect(sr[3]).toBe('3 plan_mismatch level 2, risk 0.44 tail, confidence 0.61, skips a planned verification step');
    expect(sr[5]!.startsWith('5 matches_intent probability 0.88 of 1, derived confidence 0.76, ')).toBe(true);
    expect(sr[6]).toBe('change: 1 file, 1 line added, 1 removed');
    expect(sr[7]).toBe('file 1 of 1, src slash a dot py, modified, 1 added, 1 removed');
    expect(sr.at(-2)).toBe(SR_REVIEW_CHOICES);
    expect(sr.at(-1)).toBe(SR_REVIEW_PROMPT);
    expect(reviewAriaLabel(req, 'plan_mismatch')).toBe('plan_mismatch level 2, risk 0.44 tail, confidence 0.61, skips a planned verification step');
  });
  it('reviewHeaderLines with the screen-reader set never draws the ruler nor a bar or band glyph (§6.5 "no ruler row")', () => {
    for (const columns of [80, 120]) {
      const full = reviewHeaderLines(req, 8, columns, GLYPHS.sr);
      expect(full.length).toBe(7);
      expect(full.some((l) => l.startsWith('dimension'))).toBe(false);
      for (const l of full) expect(l).not.toMatch(/[█▏▎▍▌▋▊▉·┆]/);
      expect(full[2]!.startsWith('1 destructive')).toBe(true);
      expect(full[6]!.startsWith('5 matches_intent')).toBe(true);
      for (let n = 1; n <= 9; n++) {
        const lines = reviewHeaderLines(req, n, columns, GLYPHS.sr);
        expect(lines.length).toBeLessThanOrEqual(Math.min(n, 7));
        for (const l of lines) expect(l).not.toMatch(/[█▏▎▍▌▋▊▉·┆]/);
      }
    }
    expect(reviewHeaderLines(req, 8, 80, GLYPHS.unicode).length).toBe(8);
  });
});

describe('preview (§6.1)', () => {
  it('indents two spaces, cuts to rows with the §24 tail only when rows are hidden, never a blank row', () => {
    const preview = ['--- old', 'return a', '+++ new', 'return b', 'more'];
    expect(reviewPreviewLines(preview, 5, 80)).toEqual(preview.map((l) => `  ${l}`));
    expect(reviewPreviewLines(preview, 4, 80)).toEqual(['  --- old', '  return a', '  +++ new', '…[2 more preview lines · e expands]']);
    expect(reviewPreviewLines(preview, 0, 80)).toEqual([]);
    expect(reviewPreviewLines([], 4, 80)).toEqual([]);
    expect(previewTail(3)).toBe('…[3 more preview lines · e expands]');
    expect(previewTail(3, GLYPHS.ascii)).toBe('...[3 more preview lines - e expands]');
    for (const l of reviewPreviewLines(['x'.repeat(500)], 1, 40)) expect(cellWidth(l)).toBeLessThanOrEqual(40);
  });
});

describe('followupLines (§9.3 box, §24 "Overlays")', () => {
  const input = { runCapUsd: 2, clampedToUsd: 0.42, sessionSpentUsd: 9.58, sessionCapUsd: 10, runs: 5, lastRunUsd: 0.71 };
  it('renders the F-P box at 5 rows × 80 columns', () => {
    const box = followupLines(input, 5, 80);
    expect(box).toEqual([
      '╭ follow-up would exceed the session cap ──────────────────────────────────────╮',
      '│ [y] start, run cap clamped to $0.42   [r] raise session cap   [n]/Esc cancel │',
      '│ session $9.58 of $10.00 (5 runs) · run cap $2.00 · last run $0.71            │',
      '│ Enter does nothing here. A clamped run stops at the session cap (spend_cap). │',
      '╰──────────────────────────────────────────────────────────────────────────────╯',
    ]);
    for (const l of box) expect(cellWidth(l)).toBe(80);
  });
  it('cuts to 3 rows as title, keys, session line; 4 rows unframed; 2 and 1 rows; 0 → []', () => {
    expect(followupLines(input, 3, 80)).toEqual([FOLLOWUP_TITLE, '[y] start, run cap clamped to $0.42   [r] raise session cap   [n]/Esc cancel', 'session $9.58 of $10.00 (5 runs) · run cap $2.00 · last run $0.71']);
    expect(followupLines(input, 4, 80)[3]).toBe(FOLLOWUP_NOTE);
    expect(followupLines(input, 2, 80).length).toBe(2);
    expect(followupLines(input, 1, 80)).toEqual([FOLLOWUP_TITLE]);
    expect(followupLines(input, 0, 80)).toEqual([]);
    expect(followupLines(input, 5, 0)).toEqual([]);
  });
  it('n > 5 still returns the 5-row box; below 20 columns the box is unframed', () => {
    expect(followupLines(input, 6, 80)).toEqual(followupLines(input, 5, 80));
    expect(followupLines(input, 12, 80).length).toBe(5);
    const narrow = followupLines(input, 5, 19);
    expect(narrow.length).toBe(4);
    expect(narrow[0]).toBe('follow-up would ex…');
    expect(narrow.some((l) => l.includes('╭') || l.includes('│') || l.includes('╰'))).toBe(false);
    for (const l of narrow) expect(cellWidth(l)).toBeLessThanOrEqual(19);
    const framed = followupLines(input, 5, 20);
    expect(framed.length).toBe(5);
    expect(framed[0]!.startsWith('╭')).toBe(true);
    for (const l of framed) expect(cellWidth(l)).toBe(20);
    for (const l of followupLines(input, 5, 1)) expect(cellWidth(l)).toBeLessThanOrEqual(1);
  });
  it('respects narrow columns, singular runs, no last run, and the ascii twin', () => {
    for (const c of [10, 30, 50]) for (const l of followupLines(input, 5, c)) expect(cellWidth(l)).toBeLessThanOrEqual(c);
    expect(followupLines({ ...input, runs: 1, lastRunUsd: null }, 3, 80)[2]).toBe('session $9.58 of $10.00 (1 run) · run cap $2.00');
    const ascii = followupLines(input, 5, 80, GLYPHS.ascii);
    for (const l of ascii) expect(l).toMatch(ASCII_RE);
    expect(ascii[0]!.startsWith('+ follow-up would exceed the session cap ---')).toBe(true);
    expect(ascii[4]).toBe(`+${'-'.repeat(78)}+`);
    expect(usd2(Number.NaN)).toBe('$nan');
    expect(usd2(0.005)).toBe('$0.01');
  });
});

describe('performance', () => {
  it('renders the 8-row 120-column header 1,000 times well under 1 ms each', () => {
    const r: ConfirmRequest = workedRequest();
    reviewHeaderLines(r, 8, 120);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) reviewHeaderLines(r, 8, 120);
    const perCall = (performance.now() - t0) / 1000;
    console.log(`[measured] reviewHeaderLines 8 rows × 120 columns: ${perCall.toFixed(3)} ms per call (bound 1 ms)`);
    expect(perCall).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// TUI-DESIGN-4 §2.6 (P-R7, S2's §9.2 request landed by S5) and §6.3 (D-Z): the keys ladder and the diff card.
// ---------------------------------------------------------------------------------------------------------------

describe('§2.6 P-R7: the review keys row is a five-rung ladder, not a truncation', () => {
  it('the five default renderings measure exactly 113 / 76 / 55 / 42 / 15 cells (§12)', () => {
    const rendered = REVIEW_KEYS_RUNGS.map((r) => fillRung(r, REVIEW_KEYS_DEFAULT_FILL));
    expect(rendered.map((r) => cellWidth(r))).toEqual([113, 76, 55, 42, 15]);
    expect(rendered[0]).toBe('[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline      [ctrl-c] abort run');
    expect(rendered[1]).toBe('[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline');
    expect(rendered[2]).toBe('[y] ok [n] no [d] note [e] expand [w] why [esc] decline');
    expect(rendered[3]).toBe('y ok · n no · d note · e exp · w why · esc');
    expect(rendered[4]).toBe('y/n/d/e/w · esc');
    // the two round-1 constants are still exactly rungs 1 and 2, so every existing pin holds
    expect(REVIEW_KEYS_120).toBe(rendered[0]);
    expect(REVIEW_KEYS_80).toBe(rendered[1]);
  });

  it('for widths 20…160 the chosen rung fits and still names every one of the six actions', () => {
    for (let columns = 20; columns <= 160; columns++) {
      const row = reviewKeys(columns);
      expect(cellWidth(row), `${columns}: ${row}`).toBeLessThanOrEqual(columns);
      // matched by the EFFECTIVE binding, not the literal letter
      for (const letter of ['y', 'n', 'd', 'e', 'w']) expect(row, `${columns}: ${row}`).toContain(letter);
      expect(row, `${columns}: ${row}`).toContain('esc');
    }
    // the ladder really is a ladder: it is monotone in the width
    const widths = [20, 40, 60, 80, 120, 160].map((c) => cellWidth(reviewKeys(c)));
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThanOrEqual(widths[i - 1]!);
    // §2.6 edge 6: the 113-cell rung newly fits at 113, not at 112
    expect(reviewKeys(112)).toBe(REVIEW_KEYS_80);
    expect(reviewKeys(113)).toBe(REVIEW_KEYS_120);
    // below the narrowest rung, `truncateCells` is the last resort and the row is never empty
    expect(cellWidth(reviewKeys(10))).toBeLessThanOrEqual(10);
    expect(reviewKeys(10).length).toBeGreaterThan(0);
  });

  it('edge 4: approve rebound to ctrl+y prints the right letter, and the rung is re-measured after filling', () => {
    const bindings = buildBindings(new Map([['review:declineNote', ['ctrl+y']]]));
    const fill = reviewKeyFill(bindings);
    expect(fill['note']).toBe('ctrl-y');
    // the rung is measured AFTER filling: `[ctrl-y]` is five cells wider than `[d]`, so rung 2 (81 cells now) no
    // longer fits 80 and the ladder steps down to rung 3 — which is the whole point of §2.6 edge 4
    expect(fillRung(REVIEW_KEYS_RUNGS[1] ?? '', fill)).toHaveLength(81);
    const row = reviewKeys(80, GLYPHS.unicode, { bindings });
    expect(row).toBe('[y] ok [n] no [ctrl-y] note [e] expand [w] why [esc] decline');
    expect(cellWidth(row)).toBeLessThanOrEqual(80);
    expect(reviewKeys(90, GLYPHS.unicode, { bindings })).toContain('[ctrl-y] decline+note');
    // TD §6.2 invariant: `y` is reserved for approve and can never be taken
    expect(reviewKeyFill(buildBindings(new Map([['review:expand', ['y']]])))['approve']).toBe('y');
  });

  it('edge 5: `[ctrl-c] abort run` is DROPPED (not truncated) when no run is live, and the rung is re-measured shorter', () => {
    const noRun = fillRung(REVIEW_KEYS_RUNGS[0] ?? '', { ...REVIEW_KEYS_DEFAULT_FILL, abort: null });
    expect(noRun).toBe('[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline');
    expect(cellWidth(noRun)).toBe(89);
    expect(noRun.endsWith(' ')).toBe(false);
    // at 89–112 the wide rung now fits where the 76-cell one used to be chosen
    expect(reviewKeys(90, GLYPHS.unicode, { live: false })).toBe(noRun);
  });

  it('edge 2: `--ascii` is the same letters with `·` → `-`, measured in the set it is drawn in', () => {
    expect(reviewKeys(42, GLYPHS.ascii)).toBe('y ok - n no - d note - e exp - w why - esc');
    expect(reviewKeys(15, GLYPHS.ascii)).toBe('y/n/d/e/w - esc');
    for (let columns = 20; columns <= 160; columns++) expect(cellWidth(reviewKeys(columns, GLYPHS.ascii))).toBeLessThanOrEqual(columns);
  });
});

describe('§6.3: the review card body is a diff, and its tail tells the truth about `e`', () => {
  const patchReq = (): ConfirmRequest => ({
    ...req,
    proposal: {
      ...req.proposal,
      action: {
        kind: 'patch',
        diff: ['diff --git a/calc/ops.py b/calc/ops.py', '--- a/calc/ops.py', '+++ b/calc/ops.py', '@@ -12,2 +12,2 @@', '-    return a - b', '+    return a + b', 'diff --git a/README.md b/README.md', '--- /dev/null', '+++ b/README.md', '@@ -0,0 +1,2 @@', '+one', '+two', ''].join('\n'),
      },
    },
  });

  it('item 1: ≥ 2 files gets a summary block first, then the hunks of the FIRST file only', () => {
    const rows = reviewDiffLines(patchReq(), 20, 76);
    expect(rows[0]).toBe('  M calc/ops.py  +1 −1');
    expect(rows[1]).toBe('  A README.md  +2 −0');
    expect(rows[2]).toBe('  ╶──── calc/ops.py');
    expect(rows.some((l) => l.includes('+one'))).toBe(false);
  });

  it('item 3: the tail is `…[+N rows · e expands to M]` and carries NO `/diff` token on a pre-apply card', () => {
    const r = patchReq();
    const want = reviewPreviewWant(r, 76);
    const cut = reviewDiffLines(r, 3, 76);
    expect(cut).toHaveLength(3);
    expect(cut[2]).toBe(`…[+${want - 2} rows · e expands to ${want}]`);
    for (const l of [...cut, ...reviewDiffLines(r, 50, 76)]) expect(l).not.toContain('/diff');
    expect(reviewDiffTail(9, 18)).toBe('…[+9 rows · e expands to 18]');
  });

  it('every card row is exactly `columns` cells for n ∈ 3…20, in all three glyph sets', () => {
    for (const g of [GLYPHS.unicode, GLYPHS.ascii, GLYPHS.sr]) {
      for (let n = 3; n <= 20; n++) {
        for (const columns of [40, 60, 80, 120]) {
          const card = reviewCardLines(patchReq(), n, 6, columns, g);
          expect(card.length).toBeLessThanOrEqual(n + 6);
          for (const l of card) expect(cellWidth(l), `${g.mode} ${n}×${columns}: ${l}`).toBe(columns);
        }
      }
    }
  });

  it('A6-22: a title cut mid-goal closes its quote, and `read` / `run` keep today\'s target', () => {
    const long = { ...req, proposal: { ...req.proposal, goal: 'g'.repeat(200) } };
    const card = reviewCardLines(long, 3, 0, 100);
    expect(card[0]).toMatch(/"g+…" ─╮$/);
    expect(closeTitleQuote('review · a "bcdefghij"', 18, GLYPHS.unicode)).toBe('review · a "bcde…"');
    expect(closeTitleQuote('review · a "bcd"', 40, GLYPHS.unicode)).toBe('review · a "bcd"'); // nothing cut, nothing added
    const run: ConfirmRequest = { ...req, proposal: { ...req.proposal, action: { kind: 'run', command: 'pytest -q' } } };
    expect(reviewCardTitle(run, 80)).toContain('run $ pytest -q');
    expect(reviewDiffLines(run, 6, 76).every((l) => !l.includes('│'))).toBe(true);
  });

  it('§6.10: the SR twin speaks the change — signs as words, paths with slash / dot, bounded by SR_DIFF_ROWS', () => {
    const sr = reviewDiffScreenReaderLines(patchReq());
    expect(sr[0]).toBe('change: 2 files, 3 lines added, 1 removed');
    expect(sr[1]).toBe('file 1 of 2, calc slash ops dot py, modified, 1 added, 1 removed');
    expect(sr).toContain('line 12 removed: return a minus b');
    expect(sr).toContain('line 12 added: return a plus b');
    expect(spokenPath('calc/ops.py')).toBe('calc slash ops dot py');
    expect(spokenCode('return a - b')).toBe('return a minus b');
    // a pinned assertion of §6.10: with GLYPHS.sr no bar and no box glyph appears
    for (const l of reviewScreenReaderLines(patchReq())) expect(l).not.toMatch(/[█▏▎▍▌▋▊▉┆│╭╰─]/);
    // bounded, with the tail sentence
    const many: ConfirmRequest = { ...req, proposal: { ...req.proposal, action: { kind: 'write', path: 'big.py', content: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') } } };
    const long = reviewDiffScreenReaderLines(many);
    expect(long.filter((l) => /^line \d+ (added|removed)/.test(l))).toHaveLength(SR_DIFF_ROWS);
    expect(long.at(-1)).toMatch(/^… \d+ more changed lines; press 3 then diff for the full text$/);
  });

  // ---------------------------------------------------------------------------------------------------------
  // §14.2 review items 8, 9, 10, 12 and the four §6.3 cases the first draft's "ten cases" were missing.
  // ---------------------------------------------------------------------------------------------------------

  it('item 12 / §6.3: a two-file patch card title still carries its quoted goal at 80 columns', () => {
    const r = patchReq();
    const title = reviewCardLines(r, 13, 8, 80)[0]!;
    // F-E1: the named two-file form overflows the title's 30-cell target budget, so it folds — it used to eat the
    // whole goal and leave the row ending in `… …`, with no quote left for `closeTitleQuote` to repair
    expect(title).toContain('patch 2 files +3 −1');
    expect(title).toMatch(/"[^"]*"/);
    expect(title).not.toContain('… …');
    expect(cellWidth(title)).toBe(80);
    expect(reviewCardTitle(r, 80)).toBe('review · step 7 · risk 0.44 (tail) · patch 2 files +3 −1 "make parse_date timezone-aware"');
  });

  it('item 8 / §6.2: an `edit` keeps its `@@` row and drops the two columns — its numbers are snippet-relative', () => {
    const edit: ConfirmRequest = { ...req, proposal: { ...req.proposal, action: { kind: 'edit', path: 'src/a.py', old: 'x = 1\ny = 2\n', new: 'x = 2\ny = 2\n' } } };
    const rows = reviewDiffLines(edit, 20, 76);
    // no `old  new` heading and no number column: nothing on the card claims to know the file offset
    expect(rows.some((l) => l.trim() === 'old new')).toBe(false);
    expect(rows.some((l) => /^\s*\d+\s+\d*\s*│/.test(l))).toBe(false);
    expect(rows.some((l) => l.includes('@@ -1,2 +1,2 @@'))).toBe(true);
    expect(rows).toContain('  -x = 1');
    expect(rows).toContain('  +x = 2');
    // a `write` and a `patch` ARE file-absolute, so they keep the columns
    const write: ConfirmRequest = { ...req, proposal: { ...req.proposal, action: { kind: 'write', path: 'new.py', content: 'a\nb\n' } } };
    expect(reviewDiffLines(write, 20, 76).some((l) => l.trim() === 'old new')).toBe(true);
    expect(reviewDiffLines(patchReq(), 20, 76).some((l) => l.trim() === 'old new')).toBe(true);
  });

  it('item 9 / §6.3 edge 8: a write to a secret path shows the row and `content withheld (secret path)`, never a line', () => {
    const secret: ConfirmRequest = { ...req, proposal: { ...req.proposal, action: { kind: 'write', path: '.env', content: 'API_KEY=sk-live-aaaaaaaaaaaaaaaa\nDB=postgres://u:p@h/db\n' } } };
    const rows = reviewDiffLines(secret, 20, 76);
    expect(rows).toContain('  content withheld (secret path)');
    for (const l of rows) expect(l).not.toContain('sk-live');
    // …in the card, in the SR twin and in the `--plain` confirmer, which all come through the same builder
    for (const l of reviewCardLines(secret, 13, 8, 80)) expect(l).not.toContain('sk-live');
    const sr = reviewDiffScreenReaderLines(secret);
    expect(sr).toContain('content withheld (secret path)');
    for (const l of sr) expect(l).not.toContain('sk-live');
    // a nested secret is caught by the basename rule too, and a normal path is untouched
    expect(reviewDiffLines({ ...req, proposal: { ...req.proposal, action: { kind: 'write', path: 'cfg/id_rsa', content: 'PRIVATE' } } }, 20, 76).some((l) => l.includes('PRIVATE'))).toBe(false);
    expect(reviewDiffLines({ ...req, proposal: { ...req.proposal, action: { kind: 'write', path: '.env.example', content: 'API_KEY=' } } }, 20, 76).some((l) => l.includes('API_KEY='))).toBe(true);
  });

  it('item 10 / §6.10: a whitespace-only change is ONE spoken sentence, not two identical ones', () => {
    const ws: ConfirmRequest = { ...req, proposal: { ...req.proposal, action: { kind: 'patch', diff: ['--- a/a.py', '+++ b/a.py', '@@ -13 +13 @@', '-x = 1   ', '+x = 1', ''].join('\n') } } };
    const sr = reviewDiffScreenReaderLines(ws);
    expect(sr).toContain('line 13 changed: trailing whitespace removed');
    expect(sr.filter((l) => /^line \d+ (added|removed)/.test(l))).toHaveLength(0);
    // a genuine change still speaks both sides
    const real: ConfirmRequest = { ...req, proposal: { ...req.proposal, action: { kind: 'patch', diff: ['--- a/a.py', '+++ b/a.py', '@@ -13 +13 @@', '-x = 1', '+x = 2', ''].join('\n') } } };
    expect(reviewDiffScreenReaderLines(real).filter((l) => /^line \d+ (added|removed)/.test(l))).toHaveLength(2);
  });

  it('§6.3 edge 7: a binary file is ONE row naming its sizes — never a byte of it', () => {
    const bin: ConfirmRequest = {
      ...req,
      proposal: { ...req.proposal, action: { kind: 'patch', diff: ['diff --git a/assets/logo.png b/assets/logo.png', 'index 111..222 100644', 'GIT binary patch', 'literal 4200', 'zzzzzzzzzzzz', 'literal 5100', ''].join('\n') } },
    };
    const rows = reviewDiffLines(bin, 20, 76);
    expect(rows[0]).toBe('  ╶──── assets/logo.png');
    expect(rows.some((l) => l.includes('zzzz'))).toBe(false);
    expect(reviewCardTitle(bin, 80)).toContain('patch assets/logo.png binary');
    expect(reviewDiffScreenReaderLines(bin)[1]).toBe('binary file, 4.1 kibibytes before, 5.0 kibibytes after');
  });

  it('§6.3 edge 2: on a 5 000-line patch the tail names the TRUE total, past `clipDetail`\'s 60-line clip (A6-11)', () => {
    const body = Array.from({ length: 2500 }, (_, i) => [`-old ${i}`, `+new ${i}`]).flat();
    const big: ConfirmRequest = { ...req, proposal: { ...req.proposal, action: { kind: 'patch', diff: ['--- a/big.py', '+++ b/big.py', '@@ -1,2500 +1,2500 @@', ...body, ''].join('\n') } } };
    const want = reviewPreviewWant(big, 76);
    expect(want).toBeGreaterThan(60);
    const rows = reviewDiffLines(big, 8, 76);
    expect(rows).toHaveLength(8);
    expect(rows[7]).toBe(`…[+${want - 7} rows · e expands to ${want}]`);
    expect(rows[7]).not.toContain('/diff');
  });
});
