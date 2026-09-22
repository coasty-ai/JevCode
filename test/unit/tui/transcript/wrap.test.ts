/**
 * TUI-DESIGN-3 §5.1 rule 3 / §5.3 / §8 S5 (`transcript/wrap.ts`): the segment-aware wrap at ` · ` (a continuation row leads
 * with the separator), the word rule otherwise, the no-orphan rule (a final token < 4 cells joins the previous word), the
 * F-R4 step row and `[run] end … exit 4` byte for byte, the `--ascii` separator, and the §5.3 identity normaliser over 1,000
 * random step summaries: no token is ever split, dropped or reordered, and no continuation row is narrower than 4 cells.
 */
import { describe, expect, it } from 'vitest';
import { stringWidth } from '../../../../src/tui/composer/width.js';
import { GLYPHS } from '../../../../src/tui/glyphs.js';
import { formatTranscriptItem, localItem, stepSummaryText } from '../../../../src/tui/plain.js';
import { ORPHAN_MIN_CELLS, joinOrphan, joinWrapped, segmentSeparator, wrapBody } from '../../../../src/tui/transcript/wrap.js';
import { makeStepRecord } from '../../../fixtures/checkpoint/make.js';
import { mulberry32, pick } from '../composer/helpers.js';

const STEP = 'run $ python -m pytest -q tests/test_core.py · risk 0.00 ok · tests 4p/3f/0e · judge 0.49 · 4.9s · $0.006';
const END = 'end replan_stop steps=9 wall=14s cost=$0.025 (gen $0.000, jev $0.025) exit 4';
const TASK = 'Fix the failing tests in tests/test_core.py without changing the tests.';

describe('wrapBody: the F-R4 / F-R6 rows of TUI-DESIGN-3 §5.4', () => {
  it('a step row breaks before ` · ` and the separator leads the continuation (F-R4 at the 70-cell body width)', () => {
    expect(wrapBody(STEP, 70)).toEqual(['run $ python -m pytest -q tests/test_core.py · risk 0.00 ok', '· tests 4p/3f/0e · judge 0.49 · 4.9s · $0.006']);
  });
  it('`[run] end … exit 4`: the orphan `4` never sits alone — `exit` comes down with it (F-R6), at the 74-cell width of round 2 and the 70-cell width of the gutter', () => {
    expect(wrapBody(END, 74)).toEqual(['end replan_stop steps=9 wall=14s cost=$0.025 (gen $0.000, jev $0.025)', 'exit 4']);
    expect(wrapBody(END, 70)).toEqual(['end replan_stop steps=9 wall=14s cost=$0.025 (gen $0.000, jev $0.025)', 'exit 4']);
    // the plain word rule alone would have produced `… exit` / `4` at 74: the rule moves the word down
    expect(wrapBody(END, 74).at(-1)).toBe('exit 4');
  });
  it('the 71-character task wraps by the word rule at 70 (the gutter\'s price, F-R4); a `[run] warn: stop: …` row wraps at spaces', () => {
    expect(wrapBody(TASK, 70)).toEqual(['Fix the failing tests in tests/test_core.py without changing the', 'tests.']);
    expect(wrapBody(TASK, 74)).toEqual([TASK].flatMap((t) => (stringWidth(t) <= 74 ? [t] : [])).length === 1 ? [TASK] : wrapBody(TASK, 74));
    const warn = 'warn: stop: the run reached the spend cap before the plan completed; resume with a higher cap';
    const rows = wrapBody(warn, 40);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(stringWidth(r)).toBeLessThanOrEqual(40);
    expect(joinWrapped(rows)).toBe(warn);
  });
  it('the sandbox item (§5.1 rule 13) is two rows at 80 and at 120 columns (body widths 70 and 110), broken at ` · `', () => {
    const sandbox = 'seatbelt · writes only in the workspace and run dirs · secrets, ~/.ssh, ~/.aws unreadable · network on (--no-network)';
    expect(wrapBody(sandbox, 70)).toEqual(['seatbelt · writes only in the workspace and run dirs', '· secrets, ~/.ssh, ~/.aws unreadable · network on (--no-network)']);
    expect(wrapBody(sandbox, 110)).toEqual(['seatbelt · writes only in the workspace and run dirs · secrets, ~/.ssh, ~/.aws unreadable', '· network on (--no-network)']);
  });
  it('a body that fits is one row; width ≤ 0 or non-finite returns the body untouched', () => {
    expect(wrapBody('short', 70)).toEqual(['short']);
    expect(wrapBody(STEP, 0)).toEqual([STEP]);
    expect(wrapBody(STEP, Number.NaN)).toEqual([STEP]);
    expect(wrapBody('', 10)).toEqual(['']);
  });
  it('a segment wider than the row falls back to the word rule inside it; the separator leads its first row only', () => {
    const body = 'x · ' + 'word '.repeat(12).trim() + ' · e';
    const rows = wrapBody(body, 30);
    expect(rows[0]).toBe('x');
    expect(rows[1]!.startsWith('· word')).toBe(true);
    for (const r of rows.slice(2)) expect(r.startsWith('· ')).toBe(r === rows.at(-1) && r.startsWith('· e'));
    expect(joinWrapped(rows)).toBe(body);
    // a first word wider than the row is cut by grapheme, never a lone `·` row; the cut keeps every character (one space inside the
    // token is the only trace: the §5.3 join is exact whenever no token is wider than the row)
    const wide = 'a · ' + 'b'.repeat(100) + ' c d';
    const wrows = wrapBody(wide, 40);
    expect(wrows.some((r) => r === '·')).toBe(false);
    for (const r of wrows) expect(stringWidth(r)).toBeLessThanOrEqual(40);
    expect(joinWrapped(wrows).replaceAll(' ', '')).toBe(wide.replaceAll(' ', ''));
    expect(joinWrapped(wrapBody(wide, 120))).toBe(wide);
    // a cut token's last piece is never an orphan
    expect(wrapBody('a'.repeat(150), 70)).toEqual(['a'.repeat(70), 'a'.repeat(70), 'a'.repeat(10)]);
    const cut = wrapBody('x'.repeat(71), 70);
    expect(cut).toEqual(['x'.repeat(67), 'x'.repeat(4)]);
  });
  it('`--ascii` bodies split on ` - ` (glyphs.dot) and lead continuations with `- `', () => {
    const body = STEP.replaceAll(' · ', ' - ');
    expect(segmentSeparator(GLYPHS.ascii)).toBe(' - ');
    const rows = wrapBody(body, 70, GLYPHS.ascii);
    expect(rows).toEqual(['run $ python -m pytest -q tests/test_core.py - risk 0.00 ok', '- tests 4p/3f/0e - judge 0.49 - 4.9s - $0.006']);
    // the Unicode separator is not a break point under --ascii (a user's text may carry `·`)
    expect(wrapBody(STEP, 70, GLYPHS.ascii).length).toBeGreaterThan(1);
    expect(joinWrapped(wrapBody(STEP, 70, GLYPHS.ascii))).toBe(STEP);
  });
  it('CJK and emoji bodies wrap on cells: no row wider than the width, every token kept', () => {
    const cjk = '認証フローの実装 · テストを修正 · 判定 0.49 · 4.9s · $0.006';
    for (const w of [10, 14, 16, 20, 30]) {
      const rows = wrapBody(cjk, w);
      for (const r of rows) expect(stringWidth(r), `${w}: ${r}`).toBeLessThanOrEqual(w);
      // the widest token is 16 cells: from there the join is exact, below it the cut token carries one space
      if (w >= 16) expect(joinWrapped(rows)).toBe(cjk);
      else expect(joinWrapped(rows).replaceAll(' ', '')).toBe(cjk.replaceAll(' ', ''));
    }
    const emoji = '🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀 ship it';
    for (const r of wrapBody(emoji, 8)) expect(stringWidth(r)).toBeLessThanOrEqual(8);
  });
});

describe('joinOrphan (the no-orphan rule)', () => {
  it('a final row narrower than 4 cells takes the previous row\'s last token; a row of ≥ 4 cells, a one-token previous row or a row that would overflow stay', () => {
    expect(ORPHAN_MIN_CELLS).toBe(4);
    expect(joinOrphan(['a b c', '4'], 10)).toEqual(['a b', 'c 4']);
    expect(joinOrphan(['a b c', 'okay'], 10)).toEqual(['a b c', 'okay']);
    expect(joinOrphan(['abc', '4'], 10)).toEqual(['abc', '4']);
    expect(joinOrphan(['a bcdefghij', '4'], 10)).toEqual(['a bcdefghij', '4']);
    expect(joinOrphan(['only'], 10)).toEqual(['only']);
    // with a separator prefix the moved token keeps the last row's own prefix
    expect(joinOrphan(['a b c', '· 4'], 10, '· ')).toEqual(['a b', '· c 4']);
    expect(joinOrphan(['a b c', 'z'], 10, '· ')).toEqual(['a b', 'c z']);
  });
});

describe('the §5.3 identity normaliser over random step summaries (1,000 StepRecords)', () => {
  const rnd = mulberry32(20260921);
  const files = ['kth.py', 'src/core/parse_date.py', 'tests/test_core.py', 'a/very/long/path/to/some/module_name_here.py', 'README.md'];
  const commands = ['pytest -q', 'python -m pytest -q tests/test_core.py -k parse', 'npm test', 'make check'];
  const goals = ['guard k > len', 'fix the off-by-one in the tz branch', 'handle empty input', 'add the missing import and the fixture'];
  function randomStepText(): string {
    const step = Math.floor(rnd() * 120) + 1;
    const kind = pick(rnd, ['edit', 'run', 'write', 'read'] as const);
    const proposal = kind === 'run' ? { action: { kind: 'run' as const, command: pick(rnd, commands) } } : kind === 'read' ? { action: { kind: 'read' as const, paths: [pick(rnd, files)] } } : kind === 'edit' ? { goal: pick(rnd, goals), action: { kind: 'edit' as const, path: pick(rnd, files), old: 'x', new: 'y' } } : { goal: pick(rnd, goals), action: { kind: 'write' as const, path: pick(rnd, files), content: 'z' } };
    const verdict = pick(rnd, ['ok', 'review', 'block'] as const);
    const r = makeStepRecord(step, {
      proposal: { goal: 'goal', action: proposal.action, plan: { done: [], remaining: [], openProblems: [] }, rawText: '', ...('goal' in proposal ? { goal: proposal.goal } : {}) },
      risk: rnd() < 0.8 ? { risk: rnd(), verdict, level: 1, reason: 'r', mitigations: [] } : null,
      outcome: pick(rnd, [{ status: 'executed' as const, exec: { exitCode: 0, stdoutTail: '', stderrTail: '', durationMs: 1, timedOut: false, truncated: false }, summary: 's', changedFiles: rnd() < 0.5 ? ['a'] : [] }, { status: 'declined' as const, reason: 'no' }, { status: 'failed' as const, reason: 'x' }, null]),
      judge: rnd() < 0.7 ? { succeeded: rnd(), tests: rnd() < 0.6 ? { source: 'parsed' as const, passed: Math.floor(rnd() * 50), failed: Math.floor(rnd() * 5), errors: Math.floor(rnd() * 3) } : { source: 'none' as const } } : null,
      completion: rnd() < 0.5 ? rnd() : null,
      timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: Math.floor(rnd() * 200_000) },
    } as never);
    return stepSummaryText(r, rnd() < 0.8 ? { generator: rnd() * 0.01, jev: rnd() * 0.001 } : undefined);
  }
  const widestToken = (text: string): number => Math.max(...text.split(' ').map((t) => stringWidth(t)));
  it('for every random summary at widths 20..110 (never below the widest token): rows ≤ width, the join equals the text, no continuation row < 4 cells, and the label row re-joins to formatTranscriptItem', () => {
    let wrapped = 0;
    for (let i = 0; i < 1000; i++) {
      const text = randomStepText();
      const width = Math.max(widestToken(text), 20 + Math.floor(rnd() * 91));
      const rows = wrapBody(text, width);
      expect(joinWrapped(rows), `${width}: ${text}`).toBe(text);
      for (const r of rows) expect(stringWidth(r), `${width}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(width);
      for (const r of rows.slice(1)) {
        const own = r.startsWith('· ') ? r.slice(2) : r;
        expect(stringWidth(own), `orphan at ${width}: ${JSON.stringify(rows)}`).toBeGreaterThanOrEqual(ORPHAN_MIN_CELLS);
      }
      if (rows.length > 1) wrapped += 1;
      const item = localItem(text, i, { label: '[ui]' });
      expect(joinWrapped(['     [ui]', ...rows])).toBe(formatTranscriptItem(item));
    }
    expect(wrapped).toBeGreaterThan(300);
  });
});
