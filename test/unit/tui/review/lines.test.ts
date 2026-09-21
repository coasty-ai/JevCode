import { describe, expect, it } from 'vitest';
import { RISK_DIMENSIONS, type ConfirmRequest } from '../../../../src/core/types.js';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';
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
    expect(lines[0]).toBe('review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date timezone-aware"');
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
    expect(full[0]).toBe('review  step 7  risk 0.80 (tail)  edit src/a.py "make parse_date timezone-aware"');
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
    expect(t).toBe('review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py  "make parse_date timezone-aware"             jev 244ms');
    expect(cellWidth(t)).toBe(120);
    const noJev = workedRequest();
    delete noJev.jevLatencyMs;
    expect(reviewTitle(noJev, 120)).toBe('review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py  "make parse_date timezone-aware"');
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
    expect(sr.length).toBe(8);
    expect(sr[0]).toBe(reviewTitle(req, 80));
    expect(sr.some((l) => l.startsWith('dimension'))).toBe(false);
    for (const l of sr) expect(l).not.toMatch(/[█▏▎▍▌▋▊▉·┆]/);
    expect(sr[3]).toBe('3 plan_mismatch level 2, risk 0.44 tail, confidence 0.61, skips a planned verification step');
    expect(sr[5]!.startsWith('5 matches_intent probability 0.88 of 1, derived confidence 0.76, ')).toBe(true);
    expect(sr[6]).toBe(SR_REVIEW_CHOICES);
    expect(sr[7]).toBe(SR_REVIEW_PROMPT);
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
      '┌ follow-up would exceed the session cap ──────────────────────────────────────┐',
      '│ [y] start, run cap clamped to $0.42   [r] raise session cap   [n]/Esc cancel │',
      '│ session $9.58 of $10.00 (5 runs) · run cap $2.00 · last run $0.71            │',
      '│ Enter does nothing here. A clamped run stops at the session cap (spend_cap). │',
      '└──────────────────────────────────────────────────────────────────────────────┘',
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
    expect(narrow.some((l) => l.includes('┌') || l.includes('│') || l.includes('└'))).toBe(false);
    for (const l of narrow) expect(cellWidth(l)).toBeLessThanOrEqual(19);
    const framed = followupLines(input, 5, 20);
    expect(framed.length).toBe(5);
    expect(framed[0]!.startsWith('┌')).toBe(true);
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
