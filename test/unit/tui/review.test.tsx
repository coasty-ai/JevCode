/**
 * TUI-DESIGN §19.3 (`review.test.tsx`): the review box draws `reviewHeaderLines(req, n, columns)` unchanged at every
 * n (the ladder is the function's), the `d` note field replaces row 2 (and its own secret gate renders there), the
 * preview is `confirmPreviewLines` through `reviewPreviewLines` with the `e expands` tail, every row ≤ columns cells,
 * the note cursor lands after the label, and the component never exceeds header + preview rows.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { CursorPosition } from 'ink';
import { NOTE_LABEL, Review, maskGlyphFor, maskHits, noteFieldRow, previewWant, reviewPreview, reviewRows } from '../../../src/tui/Review.js';
import { REVIEW_KEYS_80 as KEYS_80 } from '../../../src/tui/review/lines.js';
import { REVIEW_KEYS_80, REVIEW_KEYS_120, REVIEW_WHY_REFUSAL, reviewCardLines, reviewHeaderLines, reviewScreenReaderLines, reviewWhyRefusal } from '../../../src/tui/review/lines.js';
import type { ConfirmRequest } from '../../../src/core/types.js';
import { CONFIRM_HEADER_ROWS, confirmHeaderLines, confirmPreviewLines } from '../../../src/tui/plain.js';
import { NO_RISK_DIMENSIONS, agentBadge, manifestNeedsConfirm } from '../../../src/tui/agents/lines.js';
import { mkAgentSpec, mkManifest } from './agents/fixtures.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { detectSecrets } from '../../../src/core/redact.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import { mkConfirmRequest } from '../../fixtures/tui/fixtures.js';
import { workedRequest } from './pane/helpers.js';

afterEach(() => cleanup());

const big = mkConfirmRequest('c1', 7, { kind: 'write', path: 'big.txt', content: Array.from({ length: 30 }, (_, i) => `content line ${i}`).join('\n') });

describe('reviewRows / reviewPreview (§6.1, §6.2)', () => {
  it.each([8, 7, 6, 5, 4, 3, 2])('n=%i at 80 and 120 columns equals reviewHeaderLines and keeps the keys line', (n) => {
    for (const columns of [80, 120]) {
      const rows = reviewRows(workedRequest(), n, columns);
      expect(rows).toEqual(reviewHeaderLines(workedRequest(), n, columns));
      expect(rows.length).toBeLessThanOrEqual(n);
      expect(rows.length).toBeGreaterThanOrEqual(Math.min(n, 3));
      expect(rows[1]).toBe(columns >= 120 ? REVIEW_KEYS_120 : REVIEW_KEYS_80);
      for (const r of rows) expect(stringWidth(r)).toBeLessThanOrEqual(columns);
    }
  });

  it('the note field replaces row 2 for its lifetime; the gate line replaces it while the note has a hit', () => {
    const rows = reviewRows(workedRequest(), 8, 80, undefined, { text: 'skip the tests', gate: null });
    expect(rows[1]).toBe(`${NOTE_LABEL}skip the tests`);
    expect(rows[0]).toBe(reviewHeaderLines(workedRequest(), 8, 80)[0]);
    const gated = reviewRows(workedRequest(), 8, 80, undefined, { text: 'x', gate: 'Looks like this contains a secret (sk-ant-…). Send anyway? y/N' });
    expect(gated[1]).toBe('Looks like this contains a secret (sk-ant-…). Send anyway? y/N');
    expect(noteFieldRow({ text: 'a'.repeat(200), gate: null }, 40)).toMatch(/…$/);
    expect(stringWidth(noteFieldRow({ text: 'a'.repeat(200), gate: null }, 40))).toBeLessThanOrEqual(40);
  });

  it('TUI-DESIGN-4 §6.3: the preview is `diffRows` from the Action (signs, numbers, a fence header), cut to the rows with the truthful `…[+N rows · e expands to M]` tail', () => {
    // a 30-line `write` is `A +30 −0`: a fence row, the `old new` heading, 30 `+` rows and git's own
    // `\\ No newline at end of file` meta row (§6.2 edge 8) — and `e` is told the truth
    expect(previewWant(big)).toBe(33);
    const four = reviewPreview(big, 4, 80);
    expect(four).toHaveLength(4);
    expect(four[0]).toBe('  ╶──── big.txt');
    expect(four[1]).toBe('  old new');
    expect(four[3]).toBe('…[+30 rows · e expands to 33]');
    // §6.3 item 3: no `/diff <n>` pointer on a PRE-APPLY card (the overlay swallows printable keys and the step has no checkpoint image yet)
    for (const l of four) expect(l).not.toContain('/diff');
    const all = reviewPreview(big, 40, 80);
    expect(all).toHaveLength(33);
    expect(all.some((l) => l.includes('e expands'))).toBe(false);
    // §6.3 edge 3 (A6-9): a `write` preview never ends with a blank row
    expect(all.at(-1)?.trim()).not.toBe('');
    expect(all[2]).toBe('        1 │+content line 0');
    expect(reviewPreview(big, 0, 80)).toEqual([]);
    expect(previewWant(mkConfirmRequest('c2', 1, { kind: 'read', paths: ['a.py'] }))).toBe(0);
  });
});

describe('<Review>', () => {
  it('renders header + preview rows exactly and places the note cursor after the label on row 2', () => {
    const positions: (CursorPosition | undefined)[] = [];
    const ui = render(<Review req={big} rows={8} previewRows={4} columns={80} top={3} note={{ text: 'ok', gate: null }} cursor={(p) => positions.push(p)} />);
    const lines = (ui.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    expect(lines).toHaveLength(12);
    expect(lines[1]).toBe(`${NOTE_LABEL}ok`);
    expect(lines[8]).toBe('  ╶──── big.txt');
    expect(positions.at(-1)).toEqual({ x: NOTE_LABEL.length + 2, y: 4 });
  });

  it('renders nothing when granted no rows, and the F-I 3-row header at rows 8', () => {
    const none = render(<Review req={big} rows={0} previewRows={0} columns={80} top={0} />);
    expect(none.lastFrame()).toBe('');
    cleanup();
    const three = render(<Review req={workedRequest()} rows={3} previewRows={0} columns={80} top={0} />);
    const lines = (three.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('3 plan_mismatch L2 r=0.44 tail c=0.61 | 1 destructive L1 r=0.25 exp c=0.93');
  });
});

describe('the note row masks secret spans (§4.3 / §10.2, finding 3)', () => {
  const canary = `sk-ant-api03-${'R'.repeat(40)}`;

  it('maskHits replaces every code point of a hit with mask glyphs of the same width; nothing else moves', () => {
    expect(maskHits('abc', [], '•')).toBe('abc');
    expect(maskHits('key is secret ok', [{ start: 7, end: 13 }], '•')).toBe('key is •••••• ok');
    expect(maskHits('ééé', [{ start: 1, end: 2 }], '*')).toBe('é*é');
    expect(maskHits('a漢b', [{ start: 1, end: 2 }], '•')).toBe('a••b'); // a wide cell masks to two glyphs
    expect(maskGlyphFor(GLYPHS.unicode)).toBe('•');
    expect(maskGlyphFor(GLYPHS.ascii)).toBe('*');
  });

  it('noteFieldRow renders the detected spans as • cells (never the bytes) and keeps the label; the cursor lands after the masked text', () => {
    const text = `key is ${canary}`;
    const hits = detectSecrets(text);
    expect(hits.length).toBeGreaterThan(0);
    const row = noteFieldRow({ text, gate: null, spans: hits.map((h) => ({ start: h.start, end: h.end })) }, 120);
    expect(row).not.toContain(canary);
    expect(row).toBe(`${NOTE_LABEL}key is ${'•'.repeat(canary.length)}`);
    expect(stringWidth(row)).toBe(stringWidth(`${NOTE_LABEL}${text}`));
    // without spans the text is printed as typed (the caller decides; the App always passes the hits)
    expect(noteFieldRow({ text: 'plain', gate: null }, 80)).toBe(`${NOTE_LABEL}plain`);
    const positions: (CursorPosition | undefined)[] = [];
    render(<Review req={workedRequest()} rows={8} previewRows={0} columns={120} top={2} note={{ text, gate: null, spans: hits.map((h) => ({ start: h.start, end: h.end })) }} cursor={(p) => positions.push(p)} />);
    expect(positions.at(-1)).toEqual({ x: stringWidth(`${NOTE_LABEL}${text}`), y: 3 });
  });
});

describe('the review card arm (TUI-DESIGN-3 §5.2 A8: drawing only — `resolveKey` decides what `y` does)', () => {
  /** the `<Text>` props the component asked for, recorded through a stub theme lookup: every row's text with its role */
  it('unarmed: the keys row is the same text (nothing moves, nothing is hidden); armed (default): the same rows — the arm changes colour only', () => {
    const rows = (armed: boolean | undefined, boxed: boolean): string[] => {
      const ui = render(<Review req={workedRequest()} rows={boxed ? 9 : 8} previewRows={0} columns={80} top={0} {...(armed === undefined ? {} : { armed })} boxed={boxed} />);
      const out = (ui.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
      cleanup();
      return out;
    };
    for (const boxed of [false, true]) {
      const unarmed = rows(false, boxed);
      const armed = rows(true, boxed);
      const dflt = rows(undefined, boxed);
      expect(unarmed).toEqual(armed);
      expect(dflt).toEqual(armed);
      // the keys row is present in both frames: only `y` approves, whatever the colour says
      expect(unarmed.some((r) => r.includes(KEYS_80.trim()) || r.includes('[y] approve'))).toBe(true);
    }
  });
  it('the review invariants stay: Enter is drawn nowhere as a default, the keys line reads `[y] approve` first', () => {
    const ui = render(<Review req={workedRequest()} rows={8} previewRows={0} columns={80} top={0} armed={false} />);
    const text = (ui.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toContain('[y] approve');
    expect(text).not.toMatch(/Enter (approves|accepts)/);
  });
});

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-5 §4.6 (D-AM), §7 rows 51, and gate G-R5-7: the manifest confirm's five branches
// ---------------------------------------------------------------------------------------

describe('the manifest confirm (TUI-DESIGN-5 §4.6, D-AM)', () => {
  /**
   * A manifest confirm is a proposal ABOUT A PLAN. `proposal` and `risk` stay required on `ConfirmRequest`, so the
   * fixture fills them with sentinels: the property below is that **no rendered row carries any substring of
   * either** — the card must derive nothing from them, which is exactly why the four fields exist ([G2]).
   */
  const PROPOSAL_SENTINEL = 'ZZPROPOSALZZ';
  const RISK_SENTINEL = 'ZZRISKZZ';
  const manifestReq = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => {
    const base = mkConfirmRequest('m1', 11, { kind: 'read', paths: [`${PROPOSAL_SENTINEL}.txt`] });
    return {
      ...base,
      proposal: { ...base.proposal, goal: PROPOSAL_SENTINEL },
      risk: { ...base.risk, reason: RISK_SENTINEL },
      title: 'delegate step 11 · 3 agents · by directory',
      headline: [
        '3 agents · src/tui/** · src/loop/** · test/** · reserve $0.90 of $1.80 · verify: npm test',
        "⚠ your checkout has 7 uncommitted files; 2 of them are inside an agent's slice",
        NO_RISK_DIMENSIONS,
      ],
      body: ['tui-rows   src/tui/**   $0.60  12 steps', 'fix-store  src/loop/**  $0.60  12 steps', 'test-fixture test/**  $0.60  12 steps'],
      badge: agentBadge('tui-rows'),
      ...over,
    };
  };

  /** the SAME request with the four fields removed — the only honest control for "substitutes, never adds". */
  const withoutFields = (req: ConfirmRequest): ConfirmRequest => {
    const { title: _t, headline: _h, body: _b, badge: _g, ...rest } = req;
    return rest;
  };

  it.each([8, 7, 6, 5, 4, 3, 2])('n=%i: the branch SUBSTITUTES rows — the row count equals the same request without the four fields', (n) => {
    for (const columns of [80, 120]) {
      const req = manifestReq();
      const ordinary = reviewHeaderLines(withoutFields(req), n, columns);
      const manifest = reviewHeaderLines(req, n, columns);
      expect(manifest.length, `n=${n} columns=${columns}`).toBe(ordinary.length);
      expect(manifest[1]).toBe(columns >= 120 ? REVIEW_KEYS_120 : REVIEW_KEYS_80);
      for (const row of manifest) expect(stringWidth(row)).toBeLessThanOrEqual(columns);
    }
  });

  it.each([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])('the CARD at n=%i is count-preserving the same way', (n) => {
    for (const columns of [80, 120]) {
      const req = manifestReq();
      expect(reviewCardLines(req, n, 0, columns).length, `n=${n} columns=${columns}`).toBe(reviewCardLines(withoutFields(req), n, 0, columns).length);
    }
  });

  it('a matchesIntent on the manifest request does not change the invariant (the band follows the rung, not the field)', () => {
    for (const n of [8, 7, 6, 5, 4, 3, 2]) {
      const req = manifestReq({ matchesIntent: 0.9 });
      expect(reviewHeaderLines(req, n, 80).length, `n=${n}`).toBe(reviewHeaderLines(withoutFields(req), n, 80).length);
      expect(reviewHeaderLines(req, n, 120).length, `n=${n}@120`).toBe(reviewHeaderLines(withoutFields(req), n, 120).length);
    }
  });

  it('CONFIRM_HEADER_ROWS never moves: the shared 8-row header is still 8 rows for a manifest', () => {
    expect(CONFIRM_HEADER_ROWS).toBe(8);
    expect(confirmHeaderLines(manifestReq())).toHaveLength(CONFIRM_HEADER_ROWS);
  });

  it('the property (G-R5-7): no rendered row contains any substring of `risk` or `proposal`', () => {
    const req = manifestReq();
    const everything = [
      ...reviewHeaderLines(req, 8, 120),
      ...reviewHeaderLines(req, 2, 40),
      ...reviewCardLines(req, 12, 6, 120),
      ...reviewScreenReaderLines(req, 120),
      ...confirmPreviewLines(req),
      ...reviewPreview(req, 8, 120),
    ];
    expect(everything.length).toBeGreaterThan(10);
    for (const row of everything) {
      expect(row, row).not.toContain(PROPOSAL_SENTINEL);
      expect(row, row).not.toContain(RISK_SENTINEL);
    }
  });

  it('[G2]: the body is NOT blank — a synthetic `read` action renders nothing, `body` renders the agents', () => {
    const blank = mkConfirmRequest('m2', 11, { kind: 'read', paths: ['x.txt'] });
    expect(confirmPreviewLines({ ...blank, headline: ['h'] })).toEqual([]);
    expect(confirmPreviewLines(manifestReq())).toHaveLength(3);
    expect(reviewPreview(manifestReq(), 8, 120).join('\n')).toContain('tui-rows');
  });

  it('the title is verbatim and the badge precedes it (§7 row 51: nobody approves the wrong child)', () => {
    const rows = reviewHeaderLines(manifestReq(), 8, 120);
    expect(rows[0]).toContain('agent tui-rows');
    expect(rows[0]).toContain('delegate step 11');
    expect(rows[0]).not.toContain('review  step');
  });

  it('`review:why` is refused while `headline` is set, for all five w 1 … w 5 (`CD §F` to-do 2)', () => {
    const req = manifestReq();
    expect(reviewWhyRefusal(req)).toBe(REVIEW_WHY_REFUSAL);
    for (const dim of [1, 2, 3, 4, 5]) expect(reviewWhyRefusal(req), `w ${dim}`).not.toBeNull();
    // and it is NOT refused for an ordinary confirm, which still has five dimensions to explain
    expect(reviewWhyRefusal(workedRequest())).toBeNull();
    // the refusal names `y`, never Enter: TD §6.2's invariant is that Enter is inert (see the deviation note)
    expect(REVIEW_WHY_REFUSAL).toContain('[y] approves');
    expect(REVIEW_WHY_REFUSAL).not.toContain('[Enter] approves');
  });

  it('the screen-reader twin substitutes too, and still ends with the 1-3 prompt', () => {
    const sr = reviewScreenReaderLines(manifestReq(), 120);
    expect(sr.at(-1)).toBe('Enter selection (1-3):');
    expect(sr.join('\n')).toContain('3 agents · src/tui/**');
    expect(sr.join('\n')).not.toContain('plan_mismatch');
  });

  it("§4.6: `split: 'auto'` skips the confirm ONLY for an all-research manifest (3 research + 1 code asks)", () => {
    const research = mkManifest({ agents: [mkAgentSpec({ slug: 'r1', role: 'research', branch: null, verify: [] }), mkAgentSpec({ slug: 'r2', role: 'research', branch: null, verify: [] }), mkAgentSpec({ slug: 'r3', role: 'research', branch: null, verify: [] })] });
    expect(manifestNeedsConfirm(research, 'auto')).toBe(false);
    const mixed = mkManifest({ agents: [...research.agents, mkAgentSpec({ slug: 'c1', role: 'code' })] });
    expect(manifestNeedsConfirm(mixed, 'auto')).toBe(true);
    // a critic writes too, and `ask` / `off` always ask
    expect(manifestNeedsConfirm(mkManifest({ agents: [mkAgentSpec({ slug: 'k', role: 'critic' })] }), 'auto')).toBe(true);
    expect(manifestNeedsConfirm(research, 'ask')).toBe(true);
    expect(manifestNeedsConfirm(research, 'off')).toBe(true);
    // an empty manifest has nothing to prove safe
    expect(manifestNeedsConfirm(mkManifest({ agents: [] }), 'auto')).toBe(true);
  });

  it('an ordinary confirm is untouched by every branch — the rows are ROUND 4\'s, byte for byte', () => {
    /**
     * The case this replaces compared `reviewHeaderLines(...)` with itself, so it could never fail. These rows
     * are the literal output of the round-4 implementation (captured from HEAD before the five branches landed),
     * at both widths and at the four rungs the manifest branch touches.
     */
    for (const columns of [80, 120]) {
      for (const n of [8, 6, 3, 2]) {
        expect(reviewHeaderLines(workedRequest(), n, columns), `n=${n}@${columns}`).toEqual(HEAD_HEADER_ROWS[`${n}@${columns}`]);
      }
    }
    // the same for the boxed ladder, which shares `bandRowCount`: an ordinary confirm never enters the band
    for (const n of [9, 8, 7, 5, 3]) {
      const rows = reviewCardLines(workedRequest(), n, 0, 120);
      expect(rows.length, `card n=${n}`).toBe(n);
      expect(rows.join('\n'), `card n=${n}`).not.toContain('no risk dimensions');
    }
  });

  it('§13 identity: `body` with NO `headline` is an ordinary confirm in ALL FOUR sinks, not a manifest in one', () => {
    /**
     * `body` and `headline` are independently optional. The `--plain` twin used to key off `req.body !== undefined`
     * while every Ink / card / SR branch keyed off `headline` (`isProposalConfirm`), so a request carrying only a
     * `body` rendered the body under `--plain` and the `describeAction` diff in the TUI — the twin divergence
     * §13's identity rule forbids. §4.6 names the one discriminant: `headline`.
     */
    const bodyOnly: ConfirmRequest = { ...workedRequest(), body: ['3 agents · src/tui/**'] };
    expect(bodyOnly.headline).toBeUndefined();
    // the plain twin ignores the body and renders the action's own preview, exactly as it did without the field
    expect(confirmPreviewLines(bodyOnly)).toEqual(confirmPreviewLines(workedRequest()));
    expect(confirmPreviewLines(bodyOnly).join('\n')).not.toContain('3 agents');
    // and so do the header, the card and the SR twin — one predicate, four sinks
    expect(reviewHeaderLines(bodyOnly, 8, 120)).toEqual(reviewHeaderLines(workedRequest(), 8, 120));
    expect(reviewCardLines(bodyOnly, 9, 4, 120)).toEqual(reviewCardLines(workedRequest(), 9, 4, 120));
    expect(reviewScreenReaderLines(bodyOnly)).toEqual(reviewScreenReaderLines(workedRequest()));
    expect(reviewWhyRefusal(bodyOnly)).toBeNull();
    // with the headline present the SAME body is the manifest shape, in all four
    const manifest: ConfirmRequest = { ...bodyOnly, headline: ['delegate step 7 to 3 agents?'] };
    expect(confirmPreviewLines(manifest).join('\n')).toContain('3 agents');
    expect(reviewHeaderLines(manifest, 8, 120)).not.toEqual(reviewHeaderLines(workedRequest(), 8, 120));
    expect(reviewScreenReaderLines(manifest).join('\n')).toContain('delegate step 7 to 3 agents?');
    expect(reviewWhyRefusal(manifest)).toBe(REVIEW_WHY_REFUSAL);
  });
});

/** the round-4 rows of an ordinary confirm, captured from HEAD — the baseline "untouched" has to mean. */
const HEAD_HEADER_ROWS: Readonly<Record<string, readonly string[]>> = {
  '8@80': ["review  step 7  risk 0.44 (tail)  edit src/a.py +1 −1 \"make parse_date timezon…\"", "[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline", "dimension        lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)", "1 destructive    L1  ██▌·······  0.25 exp  0.93  changes files whose previous c…", "2 out_of_scope   L0  ··········  0.00 tail 0.98  directly does what `plan.remai…", "3 plan_mismatch  L2  ████▍·····  0.44 tail 0.61  skips a planned verification s…", "4 irreversible   L0  ··········  0.00 exp  0.96  no lasting effect, or restorab…", "5 matches_intent     ████████▊·  0.88 noul 0.76~ the action is an instance of t…"],
  '6@80': ["review  step 7  risk 0.44 (tail)  edit src/a.py +1 −1 \"make parse_date timezon…\"", "[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline", "1 destructive    L1  ██▌·······  0.25 exp  0.93  changes files whose previous c…", "2 out_of_scope   L0  ··········  0.00 tail 0.98  directly does what `plan.remai…", "3 plan_mismatch  L2  ████▍·····  0.44 tail 0.61  skips a planned verification s…", "4 irreversible   L0  ··········  0.00 exp  0.96  no lasting effect, or restorab…"],
  '3@80': ["review  step 7  risk 0.44 (tail)  edit src/a.py +1 −1 \"make parse_date timezon…\"", "[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline", "3 plan_mismatch L2 r=0.44 tail c=0.61 | 1 destructive L1 r=0.25 exp c=0.93"],
  '2@80': ["review  step 7  risk 0.44 (tail)  edit src/a.py +1 −1 \"make parse_date timezon…\"", "[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline"],
  '8@120': ["review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py +1 −1  \"make parse_date timezone-aware\"       jev 244ms", "[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline      [ctrl-c] abort run", "dimension        lvl 0  ┆   ┆ 1  risk  bnd   P(l)  E[k]  tail  conf   Jev's dominant level (why); E[k]/4; tail = P(k≥3)", "1 destructive    L1  ██▌·······  0.25  exp   0.90  0.25  0.00  0.93   changes files whose previous content is recoverab…", "2 out_of_scope   L0  ··········  0.00  tail  1.00  0.00  0.00  0.98   directly does what `plan.remaining[0]` or `task` …", "3 plan_mismatch  L2  ████▍·····  0.44  tail  0.61  0.35  0.44  0.61   skips a planned verification step", "4 irreversible   L0  ··········  0.00  exp   0.95  0.01  0.00  0.96   no lasting effect, or restorable with one git com…", "5 matches_intent     ████████▊·  0.88  noul  —     —     —     0.76~  the action is an instance of the intent: reading …"],
  '6@120': ["review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py +1 −1  \"make parse_date timezone-aware\"       jev 244ms", "[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline      [ctrl-c] abort run", "1 destructive    L1  ██▌·······  0.25  exp   0.90  0.25  0.00  0.93   changes files whose previous content is recoverab…", "2 out_of_scope   L0  ··········  0.00  tail  1.00  0.00  0.00  0.98   directly does what `plan.remaining[0]` or `task` …", "3 plan_mismatch  L2  ████▍·····  0.44  tail  0.61  0.35  0.44  0.61   skips a planned verification step", "4 irreversible   L0  ··········  0.00  exp   0.95  0.01  0.00  0.96   no lasting effect, or restorable with one git com…"],
  '3@120': ["review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py +1 −1  \"make parse_date timezone-aware\"       jev 244ms", "[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline      [ctrl-c] abort run", "3 plan_mismatch L2 r=0.44 tail c=0.61 | 1 destructive L1 r=0.25 exp c=0.93 | 5 matches_intent p=0.88 noul c=0.76~"],
  '2@120': ["review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py +1 −1  \"make parse_date timezone-aware\"       jev 244ms", "[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline      [ctrl-c] abort run"],
};

