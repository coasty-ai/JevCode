/**
 * TUI-DESIGN-2 §1.5, §4.6, §4.7, §4.8 / §8.1 S4 (the `status/lines`, `pane/model`, `review/lines`, `glyphs` extensions):
 * badge words and ` · next run`; the flat-tier badge prefix and its drop order; `⠹ thinking` · `⠹ looking` · `⠹ replying` ·
 * `asking` (`• thinking` reduced motion); `shortHelp` for `intake`; `PANEL_WIDE_COLUMNS` (strip and header short at 100 and
 * 119, long at 120); the strip's segments, drop order and `no decisions yet`; `panelLines` open (newest 5 + more row) and
 * full; the boxed review card ladder n = 9..2 and its title; the new glyphs are one cell with `--ascii` twins.
 */
import { describe, expect, it } from 'vitest';
import type { ConfirmRequest } from '../../../src/core/types.js';
import { MODE_BADGE_WORD } from '../../../src/config/defaults.js';
import { GLYPHS, cellWidth, glyphTwin } from '../../../src/tui/glyphs.js';
import { PANEL_WIDE_COLUMNS, panelLines, panelMoreRow, panelStrip, paneRuleRow, toDecisionRow, type PaneState } from '../../../src/tui/pane/model.js';
import { NOTE_LABEL_TEXT, REVIEW_KEYS_80, reviewCardLines, reviewCardTitle, reviewHeaderLines, reviewKeys } from '../../../src/tui/review/lines.js';
import { THINKING_WORDS, flatBadgePrefix, leftZoneWord, modeBadge, modeBadgeWord, shortHelp, statusLineText, statusZones, type StatusLineState } from '../../../src/tui/status/lines.js';
import { mkDecision } from '../../fixtures/tui/fixtures.js';
import { workedRequest } from './pane/helpers.js';
import { ruleRowText, type RuleRowInput } from '../../../src/tui/Pane.js';
import { brandRow } from '../../../src/tui/splash.js';

/** the spinner frame the tests pin (`spinnerFrame: 2`) and the reduced-motion glyph, read from the glyph table (TUI-DESIGN-3 D-P swaps the frames) */
const SPIN2 = GLYPHS.unicode.spinner[2]!;
const STATIC = GLYPHS.unicode.spinnerStatic;

function base(over: Partial<StatusLineState> = {}): StatusLineState {
  return { run: 'none', mode: null, status: null, ready: null, done: null, runId: null, overlay: 'none', pendingReview: null, retrying: null, blocking: null, errors: 0, stageStartedAt: null, toasts: [], git: null, spend: { run: null, session: { totalUsd: 0, capUsd: 1.25 } }, draft: { secretHits: 0 }, nowMs: 0, ...over };
}

describe('the mode badge (TUI-DESIGN-2 §1.5, §12 "Console")', () => {
  it('words: jev-only · jev+llm · llm-only; ` · next run` while a pending mode differs', () => {
    expect(modeBadgeWord('jev-only')).toBe('jev-only');
    expect(modeBadgeWord('jev-on')).toBe('jev+llm');
    expect(modeBadgeWord('jev-off')).toBe('llm-only');
    // TUI-DESIGN-3 §1.1 (D-N): the words come from MODE_BADGE_WORD; the peer's mode reads `llm+jev · verified`
    expect(modeBadgeWord('llm-jev')).toBe(MODE_BADGE_WORD['llm-jev']);
    expect(modeBadgeWord('llm-jev')).toBe('llm+jev · verified');
    expect(modeBadgeWord('llm-jev', GLYPHS.ascii)).toBe('llm+jev - verified');
    expect(modeBadge('jev-only', 'llm-jev')).toBe('llm+jev · verified · next run');
    expect(modeBadge('jev-only', null)).toBe('jev-only');
    expect(modeBadge('jev-only', 'jev-on')).toBe('jev+llm · next run');
    expect(modeBadge('jev-on', 'jev-on')).toBe('jev+llm');
    expect(modeBadge('jev-on', 'jev-only')).toBe('jev-only · next run');
    expect(modeBadge('jev-only', 'jev-on', GLYPHS.ascii)).toBe('jev+llm - next run');
  });
  it('flat tier: `<badge> · ` leads the left zone (H-J2), never under a toast, and is the first drop when short', () => {
    const s = base({ modeBadge: { mode: 'jev-only', pending: null } });
    expect(flatBadgePrefix(s, { flatBadge: true })).toBe('jev-only · ');
    expect(flatBadgePrefix(s, {})).toBe('');
    expect(flatBadgePrefix(base(), { flatBadge: true })).toBe('');
    expect(statusLineText(s, 80, { flatBadge: true })).toBe('jev-only · idle                             step 0/–  sess $0.00/1.25 ok  ? help');
    const short = statusZones(s, 44, { flatBadge: true });
    expect(short.dropped[0]).toBe('badge');
    expect(short.left).toBe('idle');
    expect(statusLineText(s, 44, { flatBadge: true })).not.toContain('jev-only');
    // the boxed tier never asks for the prefix: the badge lives in the console's top edge (H-A3 at the console width 76)
    expect(statusLineText(s, 76)).toBe('idle                                    step 0/–  sess $0.00/1.25 ok  ? help');
    // a toast owns the zone
    expect(statusLineText({ ...s, toasts: [{ id: 1, text: 'saved', level: 'ok', untilMs: 5000 }] }, 80, { flatBadge: true })).toContain('✓ saved');
    expect(statusLineText({ ...s, toasts: [{ id: 1, text: 'saved', level: 'ok', untilMs: 5000 }] }, 80, { flatBadge: true })).not.toContain('jev-only ·');
  });
});

describe('the conversational left words (TUI-DESIGN-2 §4.8, §12 "Status")', () => {
  it('⠹ thinking · ⠹ looking · ⠹ replying while idle; • thinking under reduced motion', () => {
    expect(THINKING_WORDS).toEqual({ intake: 'thinking', lookup: 'looking', replying: 'replying' });
    expect(leftZoneWord(base({ thinking: 'intake' }), { spinnerFrame: 2 })).toBe(`${SPIN2} thinking`);
    expect(leftZoneWord(base({ thinking: 'lookup' }), { spinnerFrame: 2 })).toBe(`${SPIN2} looking`);
    expect(leftZoneWord(base({ thinking: 'replying' }), { spinnerFrame: 2 })).toBe(`${SPIN2} replying`);
    expect(leftZoneWord(base({ thinking: 'intake' }), { reducedMotion: true })).toBe(`${STATIC} thinking`);
    expect(leftZoneWord(base({ thinking: 'intake' }), { ascii: true, spinnerFrame: 1 })).toBe(`${GLYPHS.ascii.spinner[1]} thinking`);
    expect(shortHelp(base())).toBe('? help');
    expect(shortHelp(base({ overlay: 'review' }))).toBe('? help');
    expect(shortHelp(base({ overlay: 'exitConfirm' }))).toBe('? help');
    // §3.1 rows 1 and 5 (finding 1): the submission runs under `starting` — the phase wins the word; TUI-DESIGN-3 §5.2 P7:
    // once the intake settled (`thinking(null)`) and before `run:start` the row keeps the previous idle word, never `starting`
    expect(leftZoneWord(base({ run: 'starting', thinking: 'intake' }), { spinnerFrame: 2 })).toBe(`${SPIN2} thinking`);
    expect(leftZoneWord(base({ run: 'starting', thinking: 'lookup' }), { spinnerFrame: 2 })).toBe(`${SPIN2} looking`);
    expect(leftZoneWord(base({ run: 'starting', thinking: null }))).toBe('idle');
    // a live run keeps its own words (a stale phase never shows over an engine run)
    expect(leftZoneWord(base({ run: 'live', thinking: 'intake' }))).toBe('starting');
    expect(leftZoneWord(base({ run: 'aborting', thinking: 'intake' }))).toBe('aborting');
  });
});

const row = (step: number, id: string, stage: 'risk' | 'intent' | 'judge' = 'risk') => toDecisionRow(mkDecision({ step, id, stage }));
function paneState(over: Partial<PaneState> = {}): PaneState {
  return { tab: 'd', step: 7, rows: Array.from({ length: 12 }, (_, i) => row(7, `dim${i}`)), plan: { step: 7, plan: { done: [{ text: 'a', evidence: { step: 5, judged: 0.9 } }, { text: 'b', evidence: { step: 6, judged: 0.8 } }], remaining: ['c', 'd', 'e'], unverified: [], harnessProblems: [], openProblems: [] } }, timeline: [], synth: null, mode: 'jev-only', lastRisk: { risk: 0.44, verdict: 'review' }, ...over };
}

describe('panelStrip and PANEL_WIDE_COLUMNS (TUI-DESIGN-2 §4.6, §12 "Rule row")', () => {
  it('H-F1 / H-F1w: the strip at 80 and 120; long labels, the jev segment and the 5-rule tail only from 120', () => {
    expect(PANEL_WIDE_COLUMNS).toBe(120);
    const s = { ...paneState(), latencies: [244] };
    // OWNER ADDENDUM: the collapsed strip lost the hotkey legend, so the freed width keeps one more pane segment
    expect(panelStrip(s, 80)).toBe('─── ▸ jev s7 · 12 decisions · risk 0.44 [review] · plan 2/5 ────────────────────');
    expect(panelStrip(s, 120)).toBe('─── ▸ jev s7 · 12 decisions · risk 0.44 [review] · plan 2/5 · jev 244ms ────────────────────────────────────────────────');
    for (const c of [100, 119]) {
      expect(panelStrip(s, c)).not.toContain('[d]');
      expect(panelStrip(s, c)).not.toContain('jev 244ms');
      expect(paneRuleRow(paneState(), 6, c, 'none', { chevron: true })).toContain('[t]ime [s]ynth ──');
      expect(cellWidth(panelStrip(s, c))).toBe(c);
    }
    expect(paneRuleRow(paneState(), 6, 120, 'none', { chevron: true })).toBe('─── ▾ decisions s7 · c~ derived |2p−1| ───────────────────────────────────── [d]ecisions [p]lan [t]imeline [s]ynth ─────');
    expect(paneRuleRow(paneState(), 6, 80, 'none', { chevron: true })).toBe('─── ▾ decisions s7 · c~ derived |2p−1| ──── [d]ecisions [p]lan [t]ime [s]ynth ──');
    // without the chevron option today's header is unchanged
    expect(paneRuleRow(paneState(), 6, 80, 'none')).toBe('─── decisions s7 · c~ derived |2p−1| ────── [d]ecisions [p]lan [t]ime [s]ynth ──');
  });
  it('H-D1: `plan` stays when ≥ 4 rule cells separate it from the labels; segments drop from the right; `no decisions yet` before the first decision; every width 40..400 is exact', () => {
    const d1 = { ...paneState({ step: 3, rows: Array.from({ length: 9 }, (_, i) => row(3, `d${i}`)), lastRisk: { risk: 0.1, verdict: 'ok' }, plan: { step: 3, plan: { done: [{ text: 'a', evidence: { step: 1, judged: 0.9 } }], remaining: ['b', 'c'], unverified: [], harnessProblems: [], openProblems: [] } } }), latencies: [110] };
    expect(panelStrip(d1, 80)).toBe('─── ▸ jev s3 · 9 decisions · risk 0.10 ok · plan 1/3 ───────────────────────────');
    expect(panelStrip(d1, 120)).toBe('─── ▸ jev s3 · 9 decisions · risk 0.10 ok · plan 1/3 · jev 110ms ───────────────────────────────────────────────────────');
    expect(panelStrip(d1, 66)).toBe('─── ▸ jev s3 · 9 decisions · risk 0.10 ok · plan 1/3 ─────────────');
    expect(panelStrip(d1, 64)).toBe('─── ▸ jev s3 · 9 decisions · risk 0.10 ok · plan 1/3 ───────────');
    expect(panelStrip(d1, 60)).toBe('─── ▸ jev s3 · 9 decisions · risk 0.10 ok · plan 1/3 ───────');
    expect(panelStrip(d1, 50)).toBe('─── ▸ jev s3 · 9 decisions · risk 0.10 ok ────────'); // `plan` would leave 3 rule cells at the end: dropped
    expect(panelStrip({ ...paneState({ rows: [], lastRisk: null }), latencies: [] }, 80)).toBe('─── ▸ jev · no decisions yet ───────────────────────────────────────────────────');
    for (let c = 40; c <= 400; c += 13) expect(cellWidth(panelStrip(d1, c))).toBe(Math.min(c, 400));
    expect(panelStrip(d1, 80, GLYPHS.ascii)).toMatch(/^[\x20-\x7e]*$/);
    expect(panelStrip(d1, 80, GLYPHS.ascii).startsWith('--- > jev s3 - 9 decisions')).toBe(true);
  });
  it('the intakes’ rows count towards the strip and pin first on the open decisions tab (§3.11)', () => {
    const chat = [toDecisionRow(mkDecision({ step: 0, stage: 'intent', id: 'intake' }))];
    const s = paneState({ chatRows: chat });
    expect(panelStrip({ ...s, latencies: [] }, 80)).toContain('13 decisions');
    const open = panelLines(s, 6, 80, 'none', { size: 'open' });
    expect(open).toHaveLength(6);
    expect(open[0]).toMatch(/^s0 intent\s+intake/);
    expect(open[5]).toBe(panelMoreRow(8));
    expect(panelMoreRow(8)).toBe('  … 8 more rows · /panel full expands');
    expect(panelMoreRow(1)).toBe('  … 1 more row · /panel full expands');
  });
});

describe('panelLines (TUI-DESIGN-2 §4.6)', () => {
  it('open: ≤ 6 rows, the newest decisions with the more row when the tab has more; full: today’s 12-row pane', () => {
    const s = paneState();
    const open = panelLines(s, 6, 80, 'none', { size: 'open' });
    expect(open).toHaveLength(6);
    expect(open[0]).toMatch(/^s7 risk\s+dim7/);
    expect(open[4]).toMatch(/^s7 risk\s+dim11/);
    expect(open[5]).toBe(panelMoreRow(7));
    for (const l of open) expect(cellWidth(l)).toBeLessThanOrEqual(80);
    const few = panelLines(paneState({ rows: [row(7, 'a'), row(7, 'b')] }), 6, 80, 'none', { size: 'open' });
    expect(few).toHaveLength(2);
    expect(few.some((l) => l.includes('more row'))).toBe(false);
    const full = panelLines(s, 12, 80, 'none', { size: 'full' });
    expect(full).toHaveLength(12);
    expect(full[0]).toMatch(/^s7 risk\s+dim0/);
    // other tabs: the first rows and the more row
    const plan = panelLines(paneState({ tab: 'p', plan: { step: 7, plan: { done: Array.from({ length: 8 }, (_, i) => ({ text: `done ${i}`, evidence: { step: i + 1, judged: 0.9 } })), remaining: ['r1', 'r2', 'r3', 'r4', 'r5'], unverified: [], harnessProblems: [], openProblems: [] } } }), 6, 80, 'none', { size: 'open' });
    expect(plan).toHaveLength(6);
    expect(plan[5]).toMatch(/^  … \d+ more rows · \/panel full expands$/);
    expect(panelLines(s, 0, 80, 'none', { size: 'open' })).toEqual([]);
    expect(panelLines(paneState({ tab: 's' }), 6, 80, 'none', { size: 'open' })).toEqual(['(no synth output yet)']);
  });
});

describe('reviewCardLines and reviewCardTitle (TUI-DESIGN-2 §4.7, §12 "Cards")', () => {
  const req: ConfirmRequest = workedRequest();
  it('the title: `review · step 7 · risk 0.44 (tail) · edit src/a.py "<goal>"`; ≥ 120 adds `(tail on <dim>)`, the full goal and ` · jev 244ms`', () => {
    // TUI-DESIGN-4 §6.1 / §6.3 (D-Z): the title takes `editSummary`'s target, so every edit action names its
    // files AND its churn (`+1 −1`) — a `patch` used to read `18 line unified diff` (A6-1)
    expect(reviewCardTitle(req, 80)).toBe('review · step 7 · risk 0.44 (tail) · edit src/a.py +1 −1 "make parse_date timezone-aware"');
    expect(reviewCardTitle(req, 120)).toBe('review · step 7 · risk 0.44 (tail on plan_mismatch) · edit src/a.py +1 −1 "make parse_date timezone-aware" · jev 244ms');
    expect(reviewCardTitle({ ...req, proposal: { ...req.proposal, goal: 'x'.repeat(100) } }, 80)).toBe(`review · step 7 · risk 0.44 (tail) · edit src/a.py +1 −1 "${'x'.repeat(39)}…"`);
  });
  it('H-F1 after D-Z: the full card at 80 columns — 9 header rows + the diff preview, every row exactly 80 cells', () => {
    // TUI-DESIGN-4 §6.3 (A6-2, A6-8): the preview is `diffRows`, not two blobs labelled `--- old` / `+++ new`; the
    // worked `edit` is a one-line change, so it asks for 4 rows (a fence, the hunk header, `-` and `+`).
    // §14.2 review item 8: an `edit`'s two sides are a SNIPPET — `Action.edit` is an "exact, unique match" and
    // `unifiedDiff(old, new)` numbers it from 1 — so the two number columns would claim the change lands at line 1
    // of the file whatever its real offset. An `edit` keeps its `@@` row, which is honest about being
    // snippet-relative, and drops the columns; a `patch` and a `write` are file-absolute and keep them.
    const lines = reviewCardLines(req, 9, 6, 80);
    expect(lines).toHaveLength(13);
    for (const l of lines) expect(cellWidth(l)).toBe(80);
    // A6-22: the goal's quote is closed before the title is truncated
    expect(lines[0]).toBe('╭─ review · step 7 · risk 0.44 (tail) · edit src/a.py +1 −1 "make parse_dat…" ─╮');
    expect(lines[1]).toBe(`│ ${REVIEW_KEYS_80} │`);
    expect(lines[2]?.startsWith('│ dimension')).toBe(true);
    expect(lines[3]?.startsWith('│ 1 destructive')).toBe(true);
    expect(lines[6]?.startsWith('│ 4 irreversible')).toBe(true);
    expect(lines[7]?.startsWith('│ 5 matches_intent')).toBe(true);
    expect(lines[8]).toBe(`│   ╶──── src/a.py${' '.repeat(80 - 4 - 16)} │`);
    expect(lines[9]).toBe(`│   @@ -1 +1 @@${' '.repeat(80 - 4 - 13)} │`);
    expect(lines[10]).toBe(`│   -return datetime.strptime(s, FMT)${' '.repeat(80 - 4 - 35)} │`);
    expect(lines[11]).toBe(`│   +return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)${' '.repeat(80 - 4 - 64)} │`);
    expect(lines[12]).toBe(`╰${'─'.repeat(78)}╯`);
    // no `/diff` pointer on a PRE-apply card (§6.3 item 3): the overlay swallows printable keys and step 7 has no image yet
    for (const l of lines) expect(l).not.toContain('/diff');
    // the body rows are the flat header's rows 2..8 at the inner width
    const flat = reviewHeaderLines(req, 8, 76);
    expect(lines.slice(1, 8).map((l) => l.slice(2, -2).trimEnd())).toEqual(flat.slice(1).map((l) => l.trimEnd()));
  });
  it('the ladder: 9 full · 8 drops the ruler · 7 drops matches_intent · 6..4 keys + n − 3 compact rows · 3 keys only · ≤ 2 the flat ladder; every row exactly columns', () => {
    for (const columns of [80, 120]) {
      const inner = columns - 4;
      expect(reviewCardLines(req, 9, 0, columns)).toHaveLength(9);
      const eight = reviewCardLines(req, 8, 0, columns);
      expect(eight).toHaveLength(8);
      expect(eight.some((l) => l.startsWith('│ dimension'))).toBe(false);
      expect(eight.some((l) => l.startsWith('│ 5 matches_intent'))).toBe(true);
      const seven = reviewCardLines(req, 7, 0, columns);
      expect(seven).toHaveLength(7);
      expect(seven.some((l) => l.startsWith('│ 5 matches_intent'))).toBe(false);
      expect(seven.some((l) => l.startsWith('│ 4 irreversible'))).toBe(true);
      for (const n of [6, 5, 4]) {
        const card = reviewCardLines(req, n, 0, columns);
        expect(card).toHaveLength(n);
        expect(card[1]).toBe(`│ ${reviewKeys(inner)}${' '.repeat(inner - cellWidth(reviewKeys(inner)))} │`);
        expect(card.slice(2, -1).every((l) => / \| |r=/.test(l))).toBe(true);
        for (const l of card) expect(cellWidth(l)).toBe(columns);
      }
      const three = reviewCardLines(req, 3, 0, columns);
      expect(three).toHaveLength(3);
      expect(three[1]?.startsWith('│ [y] approve')).toBe(true);
      expect(reviewCardLines(req, 2, 0, columns)).toEqual(reviewHeaderLines(req, 2, columns));
      expect(reviewCardLines(req, 1, 0, columns)).toEqual(reviewHeaderLines(req, 1, columns));
      expect(reviewCardLines(req, 0, 4, columns)).toEqual([]);
    }
  });
  it('the note field replaces the keys row; its gate row too; the preview tail marks hidden rows', () => {
    const noted = reviewCardLines(req, 9, 0, 80, GLYPHS.unicode, { text: 'skip the tests', gate: null });
    expect(noted[1]).toBe(`│ ${NOTE_LABEL_TEXT}skip the tests${' '.repeat(76 - NOTE_LABEL_TEXT.length - 14)} │`);
    const gated = reviewCardLines(req, 9, 0, 80, GLYPHS.unicode, { text: 'x', gate: 'Looks like this contains a secret (sk-ant-…). Send anyway? y/N' });
    expect(gated[1]?.startsWith('│ Looks like this contains a secret')).toBe(true);
    const cut = reviewCardLines(req, 9, 2, 80);
    expect(cut).toHaveLength(11);
    // §6.3 item 3 (closes A6-11): the tail names the rows hidden at THIS budget and the rows `e` would grant
    expect(cut[9]).toMatch(/^│ …\[\+\d+ rows · e expands to \d+\]\s+│$/);
    const ascii = reviewCardLines(req, 9, 4, 80, GLYPHS.ascii);
    for (const l of ascii) {
      expect(l).toMatch(/^[\x20-\x7e]*$/);
      expect(cellWidth(l)).toBe(80);
    }
  });
});

describe('the new glyphs (TUI-DESIGN-2 §4.9)', () => {
  it('every new glyph is one cell and has an ASCII twin; glyphTwin draws `+- jev-only ------ proj -+`', () => {
    const u = GLYPHS.unicode;
    const a = GLYPHS.ascii;
    const pairs: [string, string][] = [
      [u.roundTopLeft, '+'],
      [u.roundTopRight, '+'],
      [u.roundBottomLeft, '+'],
      [u.roundBottomRight, '+'],
      // MINIMAL, MARKED EDIT BY SLOT S2 (TUI-DESIGN-4 §2.8 P-R9): the ascii tees are `|`, not `+`. With `+` the
      // console divider `+---…---+` and the bottom edge `+---…---+` are byte-identical, so `--ascii` draws the status
      // compartment as a second box; `|---…---|` reads as a divider inside one box. The rest of the file is untouched.
      [u.teeLeft, '|'],
      [u.teeRight, '|'],
      [u.prompt, '>'],
      [u.chevronRight, '>'],
      [u.chevronDown, 'v'],
      [u.fence, '-'],
      [u.shade3, '#'],
      [u.shade2, '+'],
      [u.shade1, '.'],
      [u.brand, '*'],
    ];
    expect([u.roundTopLeft, u.roundTopRight, u.roundBottomLeft, u.roundBottomRight, u.teeLeft, u.teeRight]).toEqual(['╭', '╮', '╰', '╯', '├', '┤']);
    expect([u.prompt, u.chevronRight, u.chevronDown, u.fence, u.shade3, u.shade2, u.shade1, u.brand]).toEqual(['›', '▸', '▾', '╶', '▓', '▒', '░', '◆']);
    for (const [g, twin] of pairs) {
      expect(cellWidth(g)).toBe(1);
      expect(glyphTwin(g, a)).toBe(twin);
    }
    expect(glyphTwin('╭─ jev-only ────── proj ─╮', a)).toBe('+- jev-only ------ proj -+');
    expect(glyphTwin('─── ◆ jevcode 0.2.0 ─── ▸ ▾ ╶──── py ▓▒░', a)).toBe('--- * jevcode 0.2.0 --- > v ----- py #+.');
  });
});

const ruleInput = (over: Partial<RuleRowInput> = {}): RuleRowInput => ({
  state: paneState({ rows: [], lastRisk: null, step: 0, plan: null }),
  latencies: [],
  paneRows: 0,
  columns: 80,
  overlay: 'none',
  terminalRows: 24,
  panel: 'collapsed',
  splash: 'done',
  splashTime: null,
  ranBefore: false,
  version: '0.2.0',
  ...over,
});

describe('ruleRowText (TUI-DESIGN-2 §4.6, §5.4; findings 2 and 4)', () => {
  it('finding 2: the brand row is the idle rule row until the first run:ready — a submission in flight never swaps it for the strip', () => {
    expect(ruleRowText(ruleInput())).toBe(brandRow('0.2.0', 80));
    // the intake's `s0 intake` rows (§3.11) ride along before any run — still the brand row
    expect(ruleRowText(ruleInput({ state: paneState({ rows: [], lastRisk: null, step: 0, chatRows: [row(0, 'intake', 'intent')] }) }))).toBe(brandRow('0.2.0', 80));
    // RE-PINNED BY SLOT S1 (TUI-DESIGN-4 §1.2 P-H1 / edge 9, D-T a): after the first `run:ready` the strip carries the
    // permanent `◆ jevcode` prefix. `panelStrip` itself is unchanged without the option — only `ruleRowText` passes it.
    expect(ruleRowText(ruleInput({ ranBefore: true }))).toBe('─── ◆ jevcode ─ ▸ jev · no decisions yet ───────────────────────────────────────');
    expect(ruleRowText(ruleInput({ ranBefore: true, state: paneState({ rows: [], lastRisk: null, step: 3 }) }))).toContain('▸ jev');
  });
  it('finding 4: an open or full panel draws the ▾ tab header before the first run too (never a headerless hole); no rows granted → the brand row', () => {
    const open = ruleRowText(ruleInput({ panel: 'open', paneRows: 6 }));
    expect(open).toContain('─── ▾ decisions s0');
    expect(open).toContain('[d]ecisions [p]lan [t]ime [s]ynth');
    expect(cellWidth(open)).toBe(80);
    expect(ruleRowText(ruleInput({ panel: 'full', paneRows: 12 }))).toContain('─── ▾ decisions s0');
    expect(ruleRowText(ruleInput({ panel: 'open', paneRows: 6, state: paneState({ rows: [], lastRisk: null, step: 0, tab: 'p', plan: null }) }))).toContain('─── ▾ plan s0');
    // no pane rows (a tiny terminal, the layout refused the slot): the brand row, not the strip
    expect(ruleRowText(ruleInput({ panel: 'open', paneRows: 0 }))).toBe(brandRow('0.2.0', 80));
    // the splash still owns the row while it runs below 64 columns (the pulsing brand glyph)
    expect(ruleRowText(ruleInput({ panel: 'open', paneRows: 0, splash: 'running', splashTime: 50, columns: 60 }))).toBe(brandRow('0.2.0', 60, 50));
    // after run:ready the same header; collapsed → the strip
    expect(ruleRowText(ruleInput({ ranBefore: true, panel: 'open', paneRows: 6 }))).toContain('─── ▾ decisions s0');
    // RE-PINNED BY SLOT S1 (TUI-DESIGN-4 §1.2 P-H1 / edge 9): the post-run collapsed strip leads with the brand
    expect(ruleRowText(ruleInput({ ranBefore: true, panel: 'collapsed', paneRows: 0 }))).toContain('─── ◆ jevcode ─ ▸ jev');
  });
});
