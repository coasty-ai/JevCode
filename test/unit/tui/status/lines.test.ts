/**
 * TUI-DESIGN §19.0 (`lines.test.ts`): drop order at 40/60/80/100/120/140/160; the centre only with ≥ 24 free cells;
 * meter words; every §2.3 status row; the shared modules (O2 width, O4 bars, O6 money) drive the same picture.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { EngineStatus, GitState, RunResult, SpendSnapshot, StageName, StopReason } from '../../../../src/core/types.js';
import { SPARKLINE_CELLS, eighthBar, sparkline } from '../../../../src/tui/bars.js';
import { meterWord, usd2 } from '../../../../src/tui/budget/lines.js';
import { stringWidth } from '../../../../src/tui/composer/width.js';
import { GLYPHS } from '../../../../src/tui/glyphs.js';
import {
  CENTRE_MAX_CELLS,
  CENTRE_MIN_FREE,
  MAX_COLUMNS,
  badges,
  centreText,
  gitZoneText,
  kShort,
  leftZoneText,
  leftZoneWord,
  meterText,
  pausedWord,
  secretBadge,
  shortHelp,
  sparklineText,
  statusLineText,
  statusZones,
  stepText,
  tokensText,
  truncateStatus,
  wallText,
} from '../../../../src/tui/status/lines.js';
import type { GitZone, StatusLineOptions, StatusLineState } from '../../../../src/tui/status/lines.js';
import { statusPorcelainV2 } from '../../../../src/workspace/git.js';
import { bannerInput, gitBannerLine } from '../../../../src/workspace/gitstate.js';
import { mkRunResult } from '../../../fixtures/tui/fixtures.js';
import { loadStringWidth, loadWidthFixtures } from '../composer/helpers.js';

// ---------------------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------------------

function usage(input = 0, output = 0, cost = 0): SpendSnapshot['generator'] {
  return { inputTokens: input, outputTokens: output, costUsd: cost, calls: 1 };
}
function spend(totalUsd: number, capUsd: number, over: Partial<SpendSnapshot> = {}): SpendSnapshot {
  return { generator: usage(4000, 1500, totalUsd * 0.9), jev: usage(20000, 8000, totalUsd * 0.1), totalUsd, capUsd, exceeded: totalUsd >= capUsd, ...over };
}
function status(step: number, maxSteps: number, wallMs: number, s: SpendSnapshot, stage: StageName | 'idle' = 'propose', over: Partial<EngineStatus> = {}): EngineStatus {
  return { step, maxSteps, wallMs, maxWallMs: 7_200_000, stage, spend: s, stopReason: null, ...over };
}
function done(stopReason: StopReason, steps: number, wallMs: number, over: Partial<RunResult> = {}): RunResult {
  return { ...mkRunResult(stopReason), steps, wallMs, ...over };
}
const gitMain: GitZone = { head: { kind: 'branch', name: 'main', oid: 'a'.repeat(40) }, ahead: 0, behind: 0, dirty: { modified: 1, staged: 0, untracked: 0 }, linkedWorktree: false, frozen: false };
// ▂▃▂▅▂▂▇▃▂▁▂▃ on the fixed 0–1000 ms scale (8 levels of 125 ms, ceil)
const JEV12 = [150, 300, 150, 550, 150, 150, 800, 300, 150, 50, 150, 300];

function mk(over: Partial<StatusLineState> = {}): StatusLineState {
  return {
    run: 'none',
    mode: null,
    status: null,
    ready: null,
    done: null,
    runId: null,
    overlay: 'none',
    pendingReview: null,
    retrying: null,
    blocking: null,
    errors: 0,
    stageStartedAt: null,
    toasts: [],
    git: null,
    spend: { run: null, session: null },
    draft: { secretHits: 0 },
    nowMs: 0,
    ...over,
  };
}
/** F-C's live state: step 3/40 at 1m02s, run $0.09/2.00, session $0.40/10.00 */
function live(over: Partial<StatusLineState> = {}): StatusLineState {
  return mk({ run: 'live', status: status(3, 40, 62_000, spend(0.09, 2)), ready: { step: 3, maxSteps: 40 }, spend: { run: spend(0.09, 2), session: { totalUsd: 0.4, capUsd: 10 } }, ...over });
}
const spin2: StatusLineOptions = { spinnerFrame: 2 }; // ⠹
const norm = (s: string): string => s.replace(/ {2,}/g, ' ');
const ASCII_ONLY = /^[\x20-\x7e]*$/;

const DESIGN = readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'TUI-DESIGN.md'), 'utf8').split('\n');
/** the status row of a §2.3 frame is the last line before the closing fence that follows `marker` */
function frameStatusRow(marker: string): string {
  const start = DESIGN.findIndex((l) => l.includes(marker));
  expect(start).toBeGreaterThan(0);
  let i = start;
  while (!DESIGN[i]!.startsWith('```')) i++;
  i++;
  while (!DESIGN[i]!.startsWith('```')) i++;
  return DESIGN[i - 1]!;
}

function deepFreeze<T>(x: T): T {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x as Record<string, unknown>)) deepFreeze(v);
  }
  return x;
}

// ---------------------------------------------------------------------------------------
// cells: the status line measures with O2's width.ts; only the ASCII ellipsis is local
// ---------------------------------------------------------------------------------------

describe('truncateStatus (§4.2 via width.ts, §14.1 ellipsis twin)', () => {
  it('unicode is truncateCells: grapheme cut, one-cell ellipsis', () => {
    expect(truncateStatus('abcdef', 3)).toBe('ab…');
    expect(truncateStatus('abcdef', 6)).toBe('abcdef');
    expect(truncateStatus('abcdef', 0)).toBe('');
    expect(truncateStatus('abcdef', -1)).toBe('');
    expect(truncateStatus('abcdef', Number.NaN)).toBe('');
    expect(truncateStatus('abcdef', 1)).toBe('…');
    expect(truncateStatus('中文字', 3)).toBe('中…');
    expect(truncateStatus('中文字', 4)).toBe('中…');
    expect(truncateStatus('ééé', 2)).toBe('é…');
  });
  it('ascii uses the glyph table ellipsis `...` and never exceeds the cells', () => {
    expect(GLYPHS.ascii.ellipsis).toBe('...');
    expect(truncateStatus('abcdefgh', 5, true)).toBe('ab...');
    expect(truncateStatus('abcdefgh', 3, true)).toBe('...');
    expect(truncateStatus('abcdefgh', 2, true)).toBe('..');
    expect(truncateStatus('abcdefgh', 1, true)).toBe('.');
    expect(truncateStatus('abcdefgh', 0, true)).toBe('');
    expect(truncateStatus('abc', 3, true)).toBe('abc');
    expect(truncateStatus('中文字', 5, true)).toBe('中...');
    for (let n = 0; n <= 12; n++) {
      expect(stringWidth(truncateStatus('abcdefghijklmnop', n, true))).toBeLessThanOrEqual(n);
      expect(stringWidth(truncateStatus('中文字中文字中文', n, true))).toBeLessThanOrEqual(n);
    }
  });
});

// ---------------------------------------------------------------------------------------
// money, meters, clock (words and money from O6, bars from O4)
// ---------------------------------------------------------------------------------------

describe('meters (§7.4, §9.5, §9.6, §24)', () => {
  it('meterText renders the §24 forms with O6 money and words', () => {
    expect(meterText('run', 0.31, 2)).toBe('run $0.31/2.00 ok');
    expect(meterText('sess', 9.58, 10)).toBe('sess $9.58/10.00 critical');
    expect(meterText('sess', 0.5, Number.POSITIVE_INFINITY)).toBe('sess $0.50/none uncapped');
    expect(meterText('run', 2.03, 2)).toBe('run $2.03/2.00 over');
    expect(meterText('run', 1, 10, { exceeded: true })).toBe('run $1.00/10.00 over');
    expect(meterText('run', Number.NaN, 2)).toBe('run $?/2.00 ok');
    expect(meterText('run', 1.6, 2, { bar: true })).toBe('run $1.60/2.00 ████████·· high');
    expect(meterText('run', 1.6, 2, { bar: true, ascii: true })).toBe('run $1.60/2.00 ########-- high');
    expect(meterText('run', 0.88, 2, { bar: true, ascii: true })).toBe('run $0.88/2.00 ####3----- ok');
    expect(meterText('sess', 0.5, Number.POSITIVE_INFINITY, { bar: true })).toBe('sess $0.50/none uncapped');
  });
  it('an unknown cap fails closed (§9.5): `?`, never `none uncapped`; only +Infinity is uncapped', () => {
    expect(meterText('run', Number.NaN, Number.NaN)).toBe('run $?/? ok');
    expect(meterText('run', 1, Number.NaN)).toBe('run $1.00/? over');
    expect(meterText('run', 1, Number.NEGATIVE_INFINITY)).toBe('run $1.00/? over');
    expect(meterText('run', 0, 0)).toBe('run $0.00/0.00 ok');
    expect(meterText('run', 0.01, 0)).toBe('run $0.01/0.00 over');
    expect(meterText('run', 1, Number.NaN, { bar: true })).not.toContain('█');
    expect(usd2(Number.NaN)).toBe('$?');
  });
  it.each([
    [0, 10],
    [4.99, 10],
    [5, 10],
    [7.99, 10],
    [8, 10],
    [9.49, 10],
    [9.5, 10],
    [9.99, 10],
    [10, 10],
    [12, 10],
    [1, Number.POSITIVE_INFINITY],
    [Number.NaN, 10],
    [1, 0],
    [0, 0],
    [1, Number.NaN],
    [Number.NaN, Number.NaN],
    [1, Number.NEGATIVE_INFINITY],
    [-1, 10],
  ])('the word of meterText(%s, %s) is O6 meterWord', (total, cap) => {
    const word = meterText('run', total, cap).split(' ').pop();
    expect(word).toBe(meterWord(total, cap));
  });
  it('the bar is O4 eighthBar over spent/cap in both glyph sets', () => {
    for (const p of [0, 0.05, 0.24, 0.44, 0.5, 0.61, 0.78, 0.89, 0.95, 1, 1.3]) {
      expect(meterText('run', p * 2, 2, { bar: true })).toBe(`run ${usd2(p * 2)}/2.00 ${eighthBar(p)} ${meterWord(p * 2, 2)}`);
      expect(meterText('run', p * 2, 2, { bar: true, ascii: true })).toBe(`run ${usd2(p * 2)}/2.00 ${eighthBar(p, 10, GLYPHS.ascii)} ${meterWord(p * 2, 2)}`);
      expect(stringWidth(meterText('run', p * 2, 2, { bar: true }))).toBe(stringWidth('run $0.00/2.00 ') + 10 + 1 + meterWord(p * 2, 2).length);
    }
  });
  it('wallText is the zero-padded form of every §2.3 frame', () => {
    expect(wallText(0)).toBe('0m00s');
    expect(wallText(3_000)).toBe('0m03s');
    expect(wallText(26_000)).toBe('0m26s');
    expect(wallText(62_000)).toBe('1m02s');
    expect(wallText(252_000)).toBe('4m12s');
    expect(wallText(361_000)).toBe('6m01s');
    expect(wallText(3_900_000)).toBe('1h05m');
    expect(wallText(100 * 3_600_000)).toBe('100h');
    expect(wallText(Number.NaN)).toBe('');
    expect(wallText(-1)).toBe('');
    expect(wallText(Number.POSITIVE_INFINITY)).toBe('');
  });
  it('stepText is the first-frame sentinel (`-` under --ascii)', () => {
    expect(stepText(0, null)).toBe('step 0/–');
    expect(stepText(0, null, true)).toBe('step 0/-');
    expect(stepText(7, 40)).toBe('step 7/40');
    expect(stepText(7, 40, true)).toBe('step 7/40');
    expect(stepText(Number.NaN, 0)).toBe('step 0/–');
    expect(stepText(3.7, 40.2)).toBe('step 3/40');
    expect(stepText(-2, Number.NaN)).toBe('step 0/–');
  });
  it('kShort: `5.5k`, `28k`, `133k` (§7.4 / §9.5), integers below 1,000, `?` for non-finite', () => {
    expect(kShort(5_500)).toBe('5.5k');
    expect(kShort(28_000)).toBe('28k');
    expect(kShort(43_100)).toBe('43.1k');
    expect(kShort(133_000)).toBe('133k');
    expect(kShort(999)).toBe('999');
    expect(kShort(0)).toBe('0');
    expect(kShort(1_000)).toBe('1k');
    expect(kShort(1_049)).toBe('1k');
    expect(kShort(1_050)).toBe('1.1k');
    expect(kShort(-5)).toBe('0');
    expect(kShort(Number.NaN)).toBe('?');
    expect(kShort(Number.POSITIVE_INFINITY)).toBe('?');
  });
});

// ---------------------------------------------------------------------------------------
// git zone and sparkline
// ---------------------------------------------------------------------------------------

describe('git zone (§12.2, §24)', () => {
  const base: GitZone = { ...gitMain, dirty: { modified: 3, staged: 1, untracked: 1 }, ahead: 2 };
  it('renders the §24 forms; `~` is the modified count exactly as §12.2 pairs the zone with the banner', () => {
    expect(gitZoneText(base)).toBe('⎇ main ↑2 · 3~ 1?');
    expect(gitZoneText({ ...base, ahead: 0, behind: 1, dirty: { modified: 0, staged: 0, untracked: 0 } })).toBe('⎇ main ↓1');
    expect(gitZoneText({ ...base, ahead: 2, behind: 1 })).toBe('⎇ main ↑2 ↓1 · 3~ 1?');
    expect(gitZoneText({ ...base, ahead: null, behind: null, dirty: { modified: 0, staged: 0, untracked: 0 } })).toBe('⎇ main');
    expect(gitZoneText({ ...base, head: { kind: 'detached', oid: '7d731c0e9f00000000000000000000000000abcd' }, ahead: 0, dirty: { modified: 0, staged: 0, untracked: 0 } })).toBe('⎇ 7d731c0e†');
    expect(gitZoneText({ ...base, linkedWorktree: true, ahead: 0, dirty: { modified: 0, staged: 0, untracked: 0 } })).toBe('⎇ main (wt)');
    expect(gitZoneText({ ...base, head: { kind: 'unborn', name: 'main' }, ahead: null, dirty: { modified: 0, staged: 0, untracked: 2 } })).toBe('⎇ main · 2?');
    expect(gitZoneText({ ...base, head: null })).toBe('');
    // staged-only changes are the banner's `N staged`; the zone has no §24 glyph for them
    expect(gitZoneText({ ...base, ahead: 0, dirty: { modified: 0, staged: 4, untracked: 0 } })).toBe('⎇ main');
  });
  it('one `MM` file (staged and modified) is `1~`, never `2~`', () => {
    const r = statusPorcelainV2('# branch.oid ' + 'a'.repeat(40) + '\u0000# branch.head main\u00001 MM N... 100644 100644 100644 ' + 'b'.repeat(40) + ' ' + 'c'.repeat(40) + ' src/b.txt\u0000');
    expect(r.dirty).toMatchObject({ modified: 1, staged: 1, untracked: 0 });
    expect(r.dirty.entries.length).toBe(1);
    expect(gitZoneText({ ...gitMain, dirty: { modified: r.dirty.modified, staged: r.dirty.staged, untracked: r.dirty.untracked } })).toBe('⎇ main · 1~');
  });
  it('zone and banner agree on the same GitState (`3~ 1?` ↔ `3 modified · 1 staged · 1 untracked`)', () => {
    const g: GitState = {
      repo: true,
      gitDir: '/r/.git',
      commonDir: '/r/.git',
      topLevel: '/r',
      prefix: '',
      linkedWorktree: false,
      head: { kind: 'branch', name: 'main', oid: 'a'.repeat(40) },
      upstream: 'origin/main',
      ahead: 2,
      behind: 0,
      dirty: { modified: 3, staged: 1, untracked: 1, renamed: 0, unmerged: 0, submodules: 0, entries: [] },
      probedAt: '2026-09-20T10:00:00.000Z',
      probeMs: 1,
    };
    expect(gitBannerLine(bannerInput(g)).text).toBe('git main ↑2 · 3 modified · 1 staged · 1 untracked');
    const zone: GitZone = { head: g.head, ahead: g.ahead, behind: g.behind, dirty: { modified: g.dirty.modified, staged: g.dirty.staged, untracked: g.dirty.untracked }, linkedWorktree: g.linkedWorktree, frozen: false };
    expect(gitZoneText(zone)).toBe('⎇ main ↑2 · 3~ 1?');
  });
  it('ASCII twin per §14.1', () => {
    expect(gitZoneText({ ...base, behind: 1 }, true)).toBe('br main ^2 v1 - 3~ 1?');
    expect(gitZoneText({ ...base, head: { kind: 'detached', oid: '7d731c0e9f00000000000000000000000000abcd' }, ahead: 0, dirty: { modified: 0, staged: 0, untracked: 0 } }, true)).toBe('br 7d731c0e+');
  });
  it('never exceeds 24 cells: tail after the last slash first, then a grapheme cut', () => {
    const long = { ...base, head: { kind: 'branch' as const, name: 'feature/very-long-branch-name-that-goes-on', oid: null } };
    const t = gitZoneText(long);
    expect(t).toBe('⎇ very-long-… ↑2 · 3~ 1?');
    expect(stringWidth(t)).toBe(24);
    expect(stringWidth(gitZoneText(long, true))).toBeLessThanOrEqual(24);
    expect(gitZoneText(long, true)).toBe('br very-lo... ^2 - 3~ 1?');
    const tail = { ...base, head: { kind: 'branch' as const, name: 'release/2026.09', oid: null }, ahead: 0, dirty: { modified: 0, staged: 0, untracked: 0 } };
    expect(gitZoneText(tail)).toBe('⎇ release/2026.09');
    const cjk = { ...base, head: { kind: 'branch' as const, name: '機能/新しい認証フローの実装', oid: null } };
    const c = gitZoneText(cjk);
    expect(stringWidth(c)).toBeLessThanOrEqual(24);
    expect(c.startsWith('⎇ 新しい')).toBe(true);
    const emoji = { ...base, head: { kind: 'branch' as const, name: '🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀', oid: null } };
    expect(stringWidth(gitZoneText(emoji))).toBeLessThanOrEqual(24);
    const huge = { ...base, dirty: { modified: 1_000_000, staged: 1_000_000, untracked: 9_999_999 }, ahead: 1e9, behind: 1e9 };
    expect(stringWidth(gitZoneText(huge))).toBeLessThanOrEqual(24);
    expect(stringWidth(gitZoneText(base, false, 5))).toBeLessThanOrEqual(5);
    expect(gitZoneText(base, false, 0)).toBe('');
    expect(gitZoneText(base, false, Number.NaN)).toBe('');
  });
});

describe('sparkline (§7.4) is O4 bars.ts sparkline behind `jev `', () => {
  it('matches bars.ts for every level 0..1000 step 25, over the scale, null and non-finite samples', () => {
    for (let ms = 0; ms <= 1000; ms += 25) {
      expect(sparklineText([ms])).toBe(`jev ${sparkline([ms])}`);
      expect(sparklineText([ms], true)).toBe(`jev ${sparkline([ms], GLYPHS.ascii)}`);
    }
    for (const xs of [[], [null], [null, 200], [5000, -1, Number.NaN, Number.POSITIVE_INFINITY], JEV12, [...JEV12, ...JEV12]]) {
      expect(sparklineText(xs)).toBe(`jev ${sparkline(xs, GLYPHS.unicode, SPARKLINE_CELLS)}`);
      expect(stringWidth(sparklineText(xs))).toBe(16);
      expect(stringWidth(sparklineText(xs, true))).toBe(16);
    }
  });
  it('the frames: 12 cells, the last 12 samples, failed attempts as spaces, short input padded on the left', () => {
    expect(sparklineText(JEV12)).toBe('jev ▂▃▂▅▂▂▇▃▂▁▂▃');
    expect(sparklineText([...JEV12.slice(0, 10), null, null])).toBe('jev ▂▃▂▅▂▂▇▃▂▁  ');
    expect(sparklineText([150, 300, 150])).toBe('jev          ▂▃▂');
    expect(sparklineText([])).toBe(`jev ${' '.repeat(SPARKLINE_CELLS)}`);
    expect(sparklineText([...Array.from({ length: 100 }, () => 999), 0])).toBe('jev ███████████▁');
    expect(sparklineText(JEV12, true)).toBe('jev 232522732123');
    expect(ASCII_ONLY.test(sparklineText([...JEV12, null], true))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// left zone
// ---------------------------------------------------------------------------------------

describe('left zone words (§7.4, §24)', () => {
  it('idle states carry the run exit code of §13.5 (`error` runs use the error exit code)', () => {
    expect(leftZoneWord(mk())).toBe('idle');
    expect(leftZoneWord(mk({ done: done('max_steps', 7, 252_000) }))).toBe('idle exit 4');
    expect(leftZoneWord(mk({ done: done('complete', 12, 1) }))).toBe('idle exit 0');
    expect(leftZoneWord(mk({ done: done('human_abort', 3, 1) }))).toBe('idle exit 130');
    const err = (exitCode: number): RunResult => done('error', 1, 1, { error: { name: 'ConfigError', code: 'config', message: 'x', exitCode } });
    expect(leftZoneWord(mk({ done: err(2) }))).toBe('idle exit 2');
    expect(leftZoneWord(mk({ done: err(5) }))).toBe('idle exit 5');
    expect(leftZoneWord(mk({ done: done('error', 1, 1) }))).toBe('idle exit 1');
    expect(leftZoneWord(mk({ done: done('complete', 12, 1), doneExitCode: 3 }))).toBe('idle exit 3');
    expect(leftZoneWord(mk({ done: err(5), doneExitCode: Number.NaN }))).toBe('idle exit 5');
    expect(leftZoneWord(mk({ done: done('complete', 12, 1) }), { mode: 'one-shot' })).toBe('done complete');
  });
  it('phases and overlays', () => {
    expect(leftZoneWord(mk({ run: 'starting' }))).toBe('starting');
    expect(leftZoneWord(live({ run: 'aborting' }))).toBe('aborting');
    expect(leftZoneWord(live({ run: 'pausing' }))).toBe('pausing after step 3');
    expect(leftZoneWord(mk({ overlay: 'wizard' }))).toBe('setup');
    expect(leftZoneWord(live({ overlay: 'wizard' }))).toBe('setup');
    expect(leftZoneWord(mk({ overlay: 'palette' }))).toBe('palette');
    expect(leftZoneWord(live({ overlay: 'palette' }))).toBe('palette');
    expect(leftZoneWord(mk({ picker: true }))).toBe('picker');
    expect(leftZoneWord(live({ overlay: 'review' }))).toBe('review');
    expect(leftZoneWord(live({ pendingReview: { id: 'c1', step: 3 } as StatusLineState['pendingReview'] }))).toBe('review pending…');
    expect(leftZoneWord(live({ pendingReview: { id: 'c1', step: 3 } as StatusLineState['pendingReview'] }), { ascii: true })).toBe('review pending...');
    expect(leftZoneWord(live({ overlay: 'exitConfirm', status: status(5, 40, 1, spend(0, 2), 'execute') }), { spinnerFrame: 4 })).toBe('⠼ execute');
  });
  it('spinner + stage verb, jev-only marker, bare `still waiting`, reduced motion and ASCII', () => {
    expect(leftZoneWord(live(), spin2)).toBe('⠹ propose');
    expect(leftZoneWord(live(), { spinnerFrame: 0 })).toBe('⠋ propose');
    expect(leftZoneWord(live(), { spinnerFrame: 12 })).toBe('⠹ propose');
    expect(leftZoneWord(live(), { spinnerFrame: Number.NaN })).toBe('⠋ propose');
    expect(leftZoneWord(live({ mode: 'jev-only' }), spin2)).toBe('⠹ propose [synth]');
    expect(leftZoneWord(live({ mode: 'jev-on' }), spin2)).toBe('⠹ propose');
    expect(leftZoneWord(live({ status: status(5, 40, 1, spend(0, 2), 'execute') }), { spinnerFrame: 4 })).toBe('⠼ execute');
    expect(leftZoneWord(live({ status: status(5, 40, 1, spend(0, 2), 'idle') }))).toBe('starting');
    expect(leftZoneWord(live({ stageStartedAt: 0, nowMs: 45_000 }), spin2)).toBe('still waiting');
    expect(stringWidth(leftZoneWord(live({ stageStartedAt: 0, nowMs: 45_000 }), spin2))).toBeLessThanOrEqual(14);
    expect(leftZoneWord(live({ stageStartedAt: 0, nowMs: 44_999 }), spin2)).toBe('⠹ propose');
    expect(leftZoneWord(live({ stageStartedAt: 0, nowMs: Number.NaN }), spin2)).toBe('⠹ propose');
    expect(leftZoneWord(live(), { reducedMotion: true })).toBe('• propose');
    expect(leftZoneWord(live(), { reducedMotion: true, ascii: true })).toBe('* propose');
    expect(leftZoneWord(live(), { ascii: true, spinnerFrame: 2 })).toBe('- propose');
    expect(leftZoneWord(live(), { ascii: true, spinnerFrame: 3 })).toBe('\\ propose');
    expect(leftZoneWord(live(), { ascii: true, spinnerFrame: 4 })).toBe('| propose');
  });
  it('blocking, disk, retry and finishing words', () => {
    const req = { id: 'b1', step: 0, kind: 'key-rejected' as const, detail: 'x', stop: 'error' as const, exitCode: 2 };
    expect(leftZoneWord(live({ blocking: req }))).toBe('paused: key rejected');
    expect(leftZoneWord(live({ blocking: { ...req, kind: 'jev-unreachable' } }))).toBe('paused: jev unreachable');
    expect(leftZoneWord(live({ blocking: { ...req, kind: 'checkpoint-degraded' } }))).toBe('paused: checkpoint degraded');
    expect(leftZoneWord(live({ blocking: { ...req, kind: 'spend-limit' } }))).toBe('paused: spend limit');
    expect(leftZoneWord(live({ status: status(1, 40, 1, spend(0, 2), 'judge', { blocked: 'drift' }) }))).toBe('paused: model drift');
    expect(pausedWord('sandbox-unavailable')).toBe('paused: sandbox unavailable');
    expect(leftZoneWord(live({ diskErrors: 2 }))).toBe('disk ×2');
    expect(leftZoneWord(live({ diskErrors: 2 }), { ascii: true })).toBe('disk x2');
    expect(leftZoneWord(live({ diskErrors: Number.NaN }), spin2)).toBe('⠹ propose');
    const retry = { attempt: 2, maxAttempts: 3, cause: { kind: 'http' as const } };
    expect(leftZoneWord(live({ retrying: retry }))).toBe('retrying 2/3');
    expect(leftZoneWord(live({ retrying: { ...retry, cause: { kind: 'network' } } }))).toBe('offline');
    // blocking outranks retry outranks review
    expect(leftZoneWord(live({ blocking: req, retrying: retry, overlay: 'review' }))).toBe('paused: key rejected');
    expect(leftZoneWord(live({ retrying: retry, overlay: 'review' }))).toBe('retrying 2/3');
    expect(leftZoneWord(live({ status: status(3, 40, 1, spend(0, 2), 'complete', { stopReason: 'complete' }) }))).toBe('done complete');
    expect(leftZoneWord(live({ status: status(3, 40, 1, spend(0, 2), 'propose', { stopReason: 'human_abort' }) }))).toBe('aborting');
  });
  it('left badges follow the word in §7.4 order; `⚠ secret?` is the row-end badge of §4.10/F-V; toasts replace the zone', () => {
    const s = live({ errors: 3, sandbox: 'none', noNetwork: true, draft: { secretHits: 1 } });
    expect(badges(s)).toEqual(['!3', 'sandbox: none', 'no-net']);
    expect(secretBadge(s)).toBe('⚠ secret?');
    expect(secretBadge(s, true)).toBe('! secret?');
    expect(secretBadge(live())).toBe('');
    expect(secretBadge(live({ draft: { secretHits: Number.NaN } }))).toBe('');
    expect(badges(live({ sandbox: 'seatbelt' }))).toEqual([]);
    expect(badges(live({ errors: Number.NaN }))).toEqual([]);
    expect(leftZoneText(s, spin2)).toBe('⠹ propose !3 sandbox: none no-net');
    const toasts = [{ id: 1, text: 'press Ctrl-C again to exit', level: 'info' as const, untilMs: 5000 }];
    expect(leftZoneText(mk({ toasts, nowMs: 1000 }))).toBe('! press Ctrl-C again to exit');
    expect(leftZoneText(mk({ toasts, nowMs: 5000 }))).toBe('idle');
    expect(leftZoneText(mk({ toasts: [{ id: 1, text: 'jev back', level: 'ok', untilMs: 5000 }], nowMs: 1000 }))).toBe('✓ jev back');
    expect(leftZoneText(mk({ toasts: [{ id: 1, text: 'jev back', level: 'ok', untilMs: 5000 }], nowMs: 1000 }), { ascii: true })).toBe('+ jev back');
  });
  it('shortHelp per overlay (§24): exitConfirm keeps `? help` (F-W); the undo prompt lists its own keys', () => {
    expect(shortHelp(mk())).toBe('? help');
    expect(shortHelp(live({ overlay: 'review' }))).toBe('? help');
    expect(shortHelp(live({ overlay: 'exitConfirm' }))).toBe('? help');
    expect(shortHelp(mk({ overlay: 'palette' }))).toBe('Tab ⇥');
    expect(shortHelp(mk({ overlay: 'palette' }), true)).toBe('Tab');
    expect(shortHelp(mk({ picker: true }))).toBe('Esc closes');
    for (const overlay of ['wizard', 'followup', 'secret', 'blocking', 'undo'] as const) expect(shortHelp(mk({ overlay })), overlay).toBe('');
  });
});

// ---------------------------------------------------------------------------------------
// the assembled row against the §2.3 frames
// ---------------------------------------------------------------------------------------

describe('statusLineText reproduces the §2.3 frames', () => {
  const idle7 = mk({ done: done('max_steps', 7, 252_000), status: status(7, 7, 252_000, spend(0.31, 2), 'complete'), spend: { run: spend(0.31, 2), session: { totalUsd: 0.31, capUsd: 10 } } });
  it('F-A idle session start at 80 is byte-identical', () => {
    const row = statusLineText(mk({ spend: { run: null, session: { totalUsd: 0, capUsd: 10 } } }), 80);
    expect(row).toBe(frameStatusRow('**F-A.'));
    expect(stringWidth(row)).toBe(80);
  });
  it('F-B idle after run 7 at 80', () => {
    const row = statusLineText(idle7, 80);
    expect(row.startsWith('idle exit 4 ')).toBe(true);
    expect(row.endsWith('step 7/7 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help')).toBe(true);
    expect(stringWidth(row)).toBe(80);
    expect(norm(row)).toBe(norm(frameStatusRow('**F-B.')));
  });
  it('F-C live propose at 80 and F-D at 120 (git zone + sparkline appear)', () => {
    const s = live({ git: gitMain, jevLatencies: JEV12 });
    const at80 = statusLineText(s, 80, spin2);
    expect(norm(at80)).toBe(norm(frameStatusRow('**F-C.')));
    expect(at80).not.toContain('⎇');
    expect(at80).not.toContain('jev ▂');
    const at120 = statusLineText(s, 120, spin2);
    expect(norm(at120)).toBe(norm(frameStatusRow('**F-D.')));
    expect(at120.endsWith('⎇ main · 1~  jev ▂▃▂▅▂▂▇▃▂▁▂▃  ? help')).toBe(true);
    expect(stringWidth(at120)).toBe(120);
  });
  it('F-X review pending at 120 keeps `review`, the git zone and the sparkline', () => {
    const s = live({ overlay: 'review', status: status(7, 40, 252_000, spend(0.31, 2)), spend: { run: spend(0.31, 2), session: { totalUsd: 0.31, capUsd: 10 } }, git: { ...gitMain, ahead: 2 }, jevLatencies: JEV12 });
    const row = statusLineText(s, 120);
    expect(norm(row)).toBe(norm(frameStatusRow('**F-X.')));
    expect(stringWidth(row)).toBe(120);
    expect(statusZones(s, 120).dropped).toEqual([]);
  });
  it('F-Y retry with two failed attempts at 120', () => {
    const s = live({ status: status(3, 40, 86_000, spend(0.09, 2)), retrying: { attempt: 2, maxAttempts: 3, cause: { kind: 'http' } }, git: gitMain, jevLatencies: [...JEV12.slice(0, 10), null, null] });
    const row = statusLineText(s, 120);
    expect(norm(row)).toBe(norm(frameStatusRow('**F-Y.')));
    expect(row).toContain('jev ▂▃▂▅▂▂▇▃▂▁    ? help');
  });
  it('F-K palette, F-L picker, F-M wizard, F-R retry, F-U paused, F-P/F-Q follow-up', () => {
    expect(norm(statusLineText({ ...idle7, overlay: 'palette' }, 80))).toBe(norm(frameStatusRow('**F-K.')));
    expect(norm(statusLineText(mk({ picker: true, spend: { run: null, session: { totalUsd: 0, capUsd: 10 } } }), 80))).toBe(norm(frameStatusRow('**F-L.')));
    const wizard = statusLineText(mk({ overlay: 'wizard' }), 80);
    expect(norm(wizard)).toBe(norm(frameStatusRow('**F-M.')));
    expect(stringWidth(wizard)).toBe(80);
    const retry = live({ status: status(0, 40, 26_000, spend(0, 2)), spend: { run: spend(0, 2), session: { totalUsd: 0, capUsd: 10 } }, retrying: { attempt: 2, maxAttempts: 3, cause: { kind: 'http' } } });
    expect(norm(statusLineText(retry, 80))).toBe(norm(frameStatusRow('**F-R.')));
    const paused = live({ status: status(0, 40, 3_000, spend(0, 2)), spend: { run: spend(0, 2), session: { totalUsd: 0, capUsd: 10 } }, overlay: 'blocking', blocking: { id: 'b', step: 0, kind: 'key-rejected', detail: 'x', stop: 'error', exitCode: 2 } });
    expect(norm(statusLineText(paused, 80))).toBe(norm(frameStatusRow('**F-U.')));
    const followup = mk({ overlay: 'followup', done: done('max_steps', 7, 252_000), status: status(7, 7, 252_000, spend(0.71, 2), 'complete'), spend: { run: spend(0.71, 2), session: { totalUsd: 9.58, capUsd: 10 } } });
    expect(norm(statusLineText(followup, 80))).toBe(norm(frameStatusRow('**F-P.')));
    const fq = mk({ overlay: 'followup', done: done('complete', 12, 361_000), status: status(12, 40, 361_000, spend(0.71, 2), 'complete'), spend: { run: spend(0.71, 2), session: { totalUsd: 9.58, capUsd: 10 } } });
    expect(norm(statusLineText(fq, 80))).toBe(norm(frameStatusRow('**F-Q.')));
  });
  it('F-W exit confirm on a live run keeps `? help` at the right (the design row is 79 cells wide; spacing normalised)', () => {
    const s = live({ overlay: 'exitConfirm', status: status(5, 40, 161_000, spend(0.17, 2), 'execute'), spend: { run: spend(0.17, 2), session: { totalUsd: 0.48, capUsd: 10 } } });
    const row = statusLineText(s, 80, { spinnerFrame: 4 });
    expect(norm(row)).toBe(norm(frameStatusRow('**F-W.')));
    expect(row.startsWith('⠼ execute')).toBe(true);
    expect(row.endsWith('sess $0.48/10.00 ok  ? help')).toBe(true);
    expect(stringWidth(row)).toBe(80);
  });
  it('F-Z: at 120 the centre never appears with the git zone and sparkline present (115 of 120 used)', () => {
    const s = mk({ overlay: 'palette', runId: '20260920-191506-5gnampki', done: done('max_steps', 7, 252_000), status: status(7, 7, 252_000, spend(0.31, 2), 'complete'), spend: { run: spend(0.31, 2), session: { totalUsd: 0.31, capUsd: 10 } }, git: { ...gitMain, ahead: 2 }, jevLatencies: JEV12 });
    const row = statusLineText(s, 120);
    expect(norm(row)).toBe(norm(frameStatusRow('**F-Z.')));
    expect(row).not.toContain('5gnampki');
    expect(statusZones(s, 120).dropped).toEqual(['centre']);
  });
  it('F-V: `⚠ secret?` sits at the end of the status line (§4.10) — byte-identical at 80; ShortHelp yields to it', () => {
    const s = mk({ done: done('complete', 2, 41_000), status: status(2, 40, 41_000, spend(0.05, 2), 'complete'), spend: { run: spend(0.05, 2), session: { totalUsd: 0.05, capUsd: 10 } }, overlay: 'secret', draft: { secretHits: 1 } });
    const row = statusLineText(s, 80);
    expect(row).toBe(frameStatusRow('**F-V.'));
    expect(stringWidth(row)).toBe(80);
    // while typing (no overlay yet) the badge still ends the row and `? help` is the first drop
    const typing = statusLineText({ ...s, overlay: 'none' }, 80);
    expect(typing.endsWith('sess $0.05/10.00 ok  ⚠ secret?')).toBe(true);
    expect(typing).not.toContain('? help');
    expect(statusZones({ ...s, overlay: 'none' }, 80).dropped).toEqual(['help']);
    expect(statusLineText({ ...s, overlay: 'none' }, 100).endsWith('ok  ? help  ⚠ secret?')).toBe(true);
    expect(statusLineText({ ...s, overlay: 'none' }, 100, { ascii: true }).endsWith('ok  ? help  ! secret?')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// drop order and the centre
// ---------------------------------------------------------------------------------------

describe('drop order at 40/60/80/100/120/140/160 (§7.4, §19.1)', () => {
  const rich = live({ git: { ...gitMain, ahead: 2 }, jevLatencies: JEV12, title: 'fix parse_date tz', runId: '20260920-191506-5gnampki' });
  const has = (row: string, ...parts: string[]): void => {
    for (const p of parts) expect(row).toContain(p);
  };
  const lacks = (row: string, ...parts: string[]): void => {
    for (const p of parts) expect(row).not.toContain(p);
  };
  it('160: everything incl. tokens and bars; the centre still waits for 24 free cells (see the O5 report)', () => {
    const row = statusLineText(rich, 160, spin2);
    expect(stringWidth(row)).toBe(160);
    has(row, '⠹ propose', 'step 3/40 1m02s', 'run $0.09/2.00 ', 'sess $0.40/10.00 ', '⎇ main ↑2 · 1~', 'jev ▂▃▂▅▂▂▇▃▂▁▂▃', '? help', 'gen 5.5k jev 28k');
    expect(row).toMatch(/run \$0\.09\/2\.00 [█▏▎▍▌▋▊▉·]{10} ok/);
    // left 9 + right 137 + two gaps = 150 → 10 free cells: the title waits
    expect(statusZones(rich, 160, spin2).dropped).toEqual(['centre']);
    lacks(row, '"fix parse_date tz"');
  });
  it('≥ 176: the centre title appears once 24 cells are free, centred between the zones', () => {
    const row = statusLineText(rich, 176, spin2);
    expect(stringWidth(row)).toBe(176);
    has(row, '"fix parse_date tz"');
    expect(statusZones(rich, 176, spin2).dropped).toEqual([]);
    const wide = statusLineText(rich, 220, spin2);
    expect(stringWidth(wide)).toBe(220);
    expect(wide.indexOf('"fix parse_date tz"')).toBeGreaterThan(20);
    // without a title the run id takes the centre
    expect(statusLineText({ ...rich, title: null }, 220, spin2)).toContain('20260920-191506-5gnampki');
  });
  it('140: bars, no tokens', () => {
    const row = statusLineText(rich, 140, spin2);
    expect(stringWidth(row)).toBe(140);
    expect(row).toMatch(/sess \$0\.40\/10\.00 [█▏▎▍▌▋▊▉·]{10} ok/);
    lacks(row, 'gen 5.5k');
    has(row, '⎇ main', 'jev ▂', '? help');
  });
  it('120: git zone and sparkline, no bars, no centre', () => {
    const row = statusLineText(rich, 120, spin2);
    expect(stringWidth(row)).toBe(120);
    has(row, '⎇ main ↑2 · 1~', 'jev ▂▃▂▅▂▂▇▃▂▁▂▃', '? help', 'run $0.09/2.00 ok');
    lacks(row, '"fix', '5gnampki', '█');
    expect(statusZones(rich, 120, spin2).dropped).toEqual(['centre']);
  });
  it('100: ShortHelp is the first to go; git and sparkline stay', () => {
    const row = statusLineText(rich, 100, spin2);
    expect(stringWidth(row)).toBe(100);
    has(row, '⎇ main ↑2 · 1~', 'jev ▂▃▂▅▂▂▇▃▂▁▂▃');
    lacks(row, '? help');
    expect(statusZones(rich, 100, spin2).dropped).toEqual(['help', 'centre']);
  });
  it('80: git and sparkline are width-gated; help and both meters stay', () => {
    const row = statusLineText(rich, 80, spin2);
    expect(stringWidth(row)).toBe(80);
    has(row, 'step 3/40 1m02s', 'run $0.09/2.00 ok', 'sess $0.40/10.00 ok', '? help');
    lacks(row, '⎇', 'jev ▂');
    expect(statusZones(rich, 80, spin2).dropped).toEqual(['centre']);
  });
  it('60: help then the session meter drop; the wall survives (F-S content)', () => {
    const row = statusLineText(rich, 60, spin2);
    expect(stringWidth(row)).toBe(60);
    expect(norm(row)).toBe('⠹ propose step 3/40 1m02s run $0.09/2.00 ok');
    expect(statusZones(rich, 60, spin2).dropped).toEqual(['help', 'sess', 'centre']);
  });
  it('40: the wall drops too; the sentinel and run meter stay', () => {
    const row = statusLineText(rich, 40, spin2);
    expect(stringWidth(row)).toBeLessThanOrEqual(40);
    expect(norm(row)).toBe('⠹ propose step 3/40 run $0.09/2.00 ok');
    expect(statusZones(rich, 40, spin2).dropped).toEqual(['help', 'sess', 'wall', 'centre']);
  });
  it('tiny: the left zone yields last, the sentinel survives longest', () => {
    expect(statusLineText(rich, 20, spin2)).toBe('⠹ propose  step 3/40');
    expect(statusLineText(rich, 18, spin2)).toBe('⠹ prop…  step 3/40');
    expect(statusLineText(rich, 15, spin2)).toBe('⠹ p…  step 3/40');
    expect(statusLineText(rich, 12, spin2)).toBe('   step 3/40');
    expect(statusLineText(rich, 10, spin2)).toBe(' step 3/40');
    expect(statusLineText(rich, 9, spin2)).toBe('step 3/40');
    expect(statusLineText(rich, 5, spin2)).toBe('step…');
    expect(statusLineText(rich, 5, { ...spin2, ascii: true })).toBe('st...');
    expect(statusLineText(rich, 1, spin2)).toBe('…');
    expect(statusLineText(rich, 0, spin2)).toBe('');
    expect(statusLineText(rich, -3, spin2)).toBe('');
    expect(statusLineText(rich, Number.NaN, spin2)).toBe('');
    expect(stringWidth(statusLineText(rich, 80.9, spin2))).toBe(80);
  });
  it('every width from 1 to 200 fits and carries the sentinel once there is room', () => {
    const states = [
      rich,
      mk(),
      mk({ overlay: 'wizard' }),
      live({ toasts: [{ id: 1, text: 'paste of 2.3 MiB refused (limit 1 MiB); write it to a file and @-mention it', level: 'error', untilMs: 9 }], nowMs: 1 }),
      live({ draft: { secretHits: 2 }, errors: 12, sandbox: 'none', noNetwork: true, blocking: { id: 'b', step: 0, kind: 'checkpoint-degraded', detail: 'x', stop: 'error', exitCode: 3 } }),
    ];
    for (const s of states) {
      for (let c = 1; c <= 200; c++) {
        for (const ascii of [false, true]) {
          const row = statusLineText(s, c, { ...spin2, ascii });
          expect(stringWidth(row), `columns ${c} ascii ${ascii}`).toBeLessThanOrEqual(c);
          if (c >= 30) expect(row, `columns ${c}`).toContain('step ');
          if (c >= 11) expect(row.length).toBeGreaterThan(0);
        }
      }
    }
  });
  it('the left zone is not in the drop order: `paused: checkpoint degraded` (27 cells) at 80 costs the session meter, not the word (see the O5 report)', () => {
    const s = live({ status: status(0, 40, 3_000, spend(0, 2)), spend: { run: spend(0, 2), session: { totalUsd: 0, capUsd: 10 } }, overlay: 'blocking', blocking: { id: 'b', step: 0, kind: 'checkpoint-degraded', detail: 'x', stop: 'error', exitCode: 3 } });
    const row = statusLineText(s, 80);
    expect(row.startsWith('paused: checkpoint degraded')).toBe(true);
    expect(statusZones(s, 80).dropped).toEqual(['sess']);
    expect(stringWidth(row)).toBe(80);
  });
});

describe('wide terminals and the left budget (§7.4, §14.1)', () => {
  const rich = live({ git: { ...gitMain, ahead: 2 }, jevLatencies: JEV12, title: 'fix parse_date tz' });
  it('columns > 400: the row is as wide as the terminal and the right zone stays right-aligned', () => {
    const row = statusLineText(rich, 500, spin2);
    expect(stringWidth(row)).toBe(500);
    expect(row.endsWith('  ? help')).toBe(true);
    expect(row.startsWith('⠹ propose')).toBe(true);
    expect(row).toContain('"fix parse_date tz"');
    expect(stringWidth(statusLineText(mk(), 1000))).toBe(1000);
  });
  it('absurd or non-finite widths are bounded by MAX_COLUMNS; the centre text never exceeds CENTRE_MAX_CELLS', () => {
    expect(MAX_COLUMNS).toBe(4096);
    expect(stringWidth(statusLineText(rich, Number.POSITIVE_INFINITY, spin2))).toBe(MAX_COLUMNS);
    expect(stringWidth(statusLineText(rich, 1e9, spin2))).toBe(MAX_COLUMNS);
    const huge = mk({ title: 'x'.repeat(10_000), spend: { run: null, session: { totalUsd: 0, capUsd: 10 } } });
    const z = statusZones(huge, MAX_COLUMNS);
    expect(stringWidth(z.centre)).toBe(CENTRE_MAX_CELLS);
    expect(stringWidth(statusLineText(huge, MAX_COLUMNS))).toBe(MAX_COLUMNS);
  });
  it('`still waiting` at 80 keeps the whole right zone (no drop)', () => {
    const s = live({ stageStartedAt: 0, nowMs: 50_000 });
    const row = statusLineText(s, 80, spin2);
    expect(row.startsWith('still waiting ')).toBe(true);
    expect(row.endsWith('step 3/40 1m02s  run $0.09/2.00 ok  sess $0.40/10.00 ok  ? help')).toBe(true);
    expect(statusZones(s, 80, spin2).dropped).toEqual([]);
    expect(stringWidth(row)).toBe(80);
  });
});

describe('centre zone (§7.4, §14.1)', () => {
  it('appears only when ≥ 24 cells stay free, title in quotes before run id', () => {
    const s = mk({ runId: '20260920-191506-5gnampki', spend: { run: null, session: { totalUsd: 0, capUsd: 10 } } });
    expect(centreText(s)).toBe('20260920-191506-5gnampki');
    expect(centreText({ ...s, title: 'fix parse_date tz' })).toBe('"fix parse_date tz"');
    expect(centreText({ ...s, title: '  ' })).toBe('20260920-191506-5gnampki');
    expect(centreText({ ...s, title: 'a\nb\u001b[2J' })).toBe('"a ⏎ b[2J"');
    expect(centreText({ ...s, title: 'a\nb' }, true)).toBe('"a | b"');
    expect(centreText(mk())).toBe('');
    // idle: left 4 + right 37 + 2 gaps → free = 80 − 4 − 37 − 4 = 35 ≥ 24 → centre shown
    const row = statusLineText(s, 80);
    expect(row).toContain('5gnampki');
    expect(stringWidth(row)).toBe(80);
    expect(row.startsWith('idle ')).toBe(true);
    expect(row.endsWith('  ? help')).toBe(true);
    const z = statusZones(s, 4 + 37 + 4 + CENTRE_MIN_FREE);
    expect(z.centre).toBe('20260920-191506-5gnampki');
    const z2 = statusZones(s, 4 + 37 + 4 + CENTRE_MIN_FREE - 1);
    expect(z2.centre).toBe('');
    expect(z2.dropped).toEqual(['centre']);
  });
  it('bidi controls and invisible format characters never reach the row; emoji families survive', () => {
    const s = mk({ title: 'abc\u202edef\u200bghi\u2066x\u2069\u200e\u200f\u061c\ufeff\u00ad', spend: { run: null, session: { totalUsd: 0, capUsd: 10 } } });
    expect(centreText(s)).toBe('"abcdefghix"');
    const row = statusLineText(s, 100);
    expect(row).toContain('"abcdefghix"');
    expect(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u.test(row)).toBe(false);
    expect(/(?!\u200d)\p{Cf}/u.test(row)).toBe(false);
    const family = mk({ title: 'team 👨\u200d👩\u200d👧 ship', spend: { run: null, session: { totalUsd: 0, capUsd: 10 } } });
    expect(centreText(family)).toBe('"team 👨\u200d👩\u200d👧 ship"');
    expect(stringWidth(statusLineText(family, 100))).toBe(100);
    expect(centreText(mk({ title: 'a\u2028b\u2029c' }))).toBe('"a ⏎ b ⏎ c"');
  });
  it('is clipped by grapheme to the free cells; huge and wide titles never widen the row', () => {
    const s = mk({ title: 'x'.repeat(10_000), spend: { run: null, session: { totalUsd: 0, capUsd: 10 } } });
    const row = statusLineText(s, 100);
    expect(stringWidth(row)).toBe(100);
    expect(row).toContain('"xxx');
    expect(row).toContain('…');
    const cjk = statusLineText(mk({ title: '認証フローの実装'.repeat(20), spend: { run: null, session: { totalUsd: 0, capUsd: 10 } } }), 100);
    expect(stringWidth(cjk)).toBe(100);
    const emoji = statusLineText(mk({ title: '🚀'.repeat(200), spend: { run: null, session: { totalUsd: 0, capUsd: 10 } } }), 100);
    expect(stringWidth(emoji)).toBe(100);
    const asciiRow = statusLineText(mk({ title: '認証フローの実装'.repeat(20), spend: { run: null, session: { totalUsd: 0, capUsd: 10 } } }), 100, { ascii: true });
    expect(stringWidth(asciiRow)).toBe(100);
    expect(asciiRow).toContain('...  ');
    expect(ASCII_ONLY.test(asciiRow.replace(/[^\x00-\x7f]/g, ''))).toBe(true);
    expect(/\.\.\." /.test(asciiRow)).toBe(false); // the closing quote is part of the cut
  });
});

// ---------------------------------------------------------------------------------------
// shared-measure parity: the row is exactly `columns` cells by O2's measurer (and by string-width when installed)
// ---------------------------------------------------------------------------------------

describe('width parity with O2 width.ts (400 fixtures) and Ink\'s string-width', () => {
  const fixtures = loadWidthFixtures();
  it('every fixture string as a title yields a row of exactly `columns` cells', async () => {
    const live = await loadStringWidth();
    const base = mk({ spend: { run: null, session: { totalUsd: 0, capUsd: 10 } } });
    let checked = 0;
    for (const { s } of fixtures.cases) {
      const row = statusLineText({ ...base, title: s }, 120);
      expect(stringWidth(row), JSON.stringify(s)).toBe(120);
      if (live !== null) expect(live(row), JSON.stringify(s)).toBe(120);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(400);
  });
  it('keycaps, flags, ZWJ families and Hangul in the git branch and title measure as Ink measures them', () => {
    for (const name of ['1️⃣-hotfix', '🇯🇵-release', '👨\u200d👩\u200d👧-team', '한글-브랜치', '간-jamo', 'é-accent']) {
      const s = live({ git: { ...gitMain, head: { kind: 'branch', name, oid: null } }, title: name });
      for (const c of [100, 120, 200]) expect(stringWidth(statusLineText(s, c, spin2)), `${name} @ ${c}`).toBe(c);
    }
  });
});

// ---------------------------------------------------------------------------------------
// robustness, twins, purity
// ---------------------------------------------------------------------------------------

describe('robustness', () => {
  it('non-finite money, steps and clocks never throw or widen the row; unknown caps fail closed', () => {
    const weird = live({ status: status(Number.NaN, Number.NaN, Number.NaN, spend(Number.NaN, Number.NaN), 'risk'), spend: { run: spend(Number.NaN, Number.NaN), session: { totalUsd: Number.NaN, capUsd: Number.POSITIVE_INFINITY } }, nowMs: Number.NaN, stageStartedAt: Number.NaN, errors: Number.POSITIVE_INFINITY });
    const row = statusLineText(weird, 120);
    expect(stringWidth(row)).toBe(120);
    expect(row).toContain('step 0/–');
    expect(row).toContain('run $?/? ok');
    expect(row).toContain('sess $?/none uncapped');
    const spent = live({ spend: { run: spend(1, Number.NaN), session: { totalUsd: 1, capUsd: Number.NaN } } });
    expect(statusLineText(spent, 120)).toContain('run $1.00/? over  sess $1.00/? over');
  });
  it('the ASCII twin has no non-ASCII glyphs: sentinel, spinner, badges, git zone, sparkline, bars, ellipsis, toasts', () => {
    const s = live({ git: { ...gitMain, ahead: 2 }, jevLatencies: JEV12, errors: 1, draft: { secretHits: 2 }, title: 'fix — the ✓ parse_date … thing · ↑2' });
    for (const c of [40, 80, 120, 160, 200]) {
      const row = statusLineText(s, c, { ascii: true, spinnerFrame: 1 });
      expect(ASCII_ONLY.test(row), `columns ${c}: ${row}`).toBe(true);
    }
    const row = statusLineText(s, 160, { ascii: true, spinnerFrame: 1 });
    expect(row).toContain('/ propose !1');
    expect(row).toContain('br main ^2 - 1~');
    expect(row).toContain('jev 232522732123');
    expect(row).toContain('! secret?');
    expect(row).toMatch(/run \$0\.09\/2\.00 [#1-7-]{10} ok/);
    const sentinel = statusLineText(mk(), 40, { ascii: true });
    expect(sentinel).toBe('idle                    step 0/-  ? help');
    const toasted = statusLineText(live({ toasts: [{ id: 1, text: 'line1 ⏎ line2 — saved · ✓ … ↑2', level: 'error', untilMs: 9 }], nowMs: 1 }), 100, { ascii: true });
    expect(ASCII_ONLY.test(toasted)).toBe(true);
    expect(toasted).toContain('! line1 | line2 - saved - + ... ^2');
    for (const state of [mk({ overlay: 'palette' }), live({ pendingReview: { id: 'c', step: 1 } as StatusLineState['pendingReview'] }), live({ diskErrors: 3 }), live({ status: status(3, 40, 1, spend(0, 2), 'propose', { blocked: 'drift' }) }), mk({ picker: true })]) {
      expect(ASCII_ONLY.test(statusLineText(state, 120, { ascii: true })), JSON.stringify(state.overlay)).toBe(true);
    }
  });
  it('a wall override drives the 1 Hz clock without a new status event', () => {
    expect(statusLineText(live({ wallMs: 125_000 }), 80, spin2)).toContain('step 3/40 2m05s');
    expect(statusLineText(live({ wallMs: null }), 80, spin2)).toContain('step 3/40 1m02s');
    expect(statusLineText(live({ wallMs: Number.NaN }), 80, spin2)).toContain('step 3/40 1m02s');
  });
  it('tokens at ≥ 160: `gen 5.5k jev 28k`, jev-only `jev 28k`, token cap `gen 43.1k/133k tok` (§9.5)', () => {
    expect(tokensText(live(), spend(0.09, 2))).toBe('gen 5.5k jev 28k');
    const row = statusLineText(live({ mode: 'jev-only' }), 160, spin2);
    expect(row).toContain('propose [synth]');
    expect(row).toContain('jev 28k');
    expect(row).not.toContain('gen ');
    const capped = statusLineText(live({ status: status(3, 40, 62_000, spend(0.09, 2), 'propose', { generatorTokens: { used: 43_100, cap: 133_000 } }) }), 160, spin2);
    expect(capped).toContain('gen 43.1k/133k tok');
    expect(statusLineText(live(), 159, spin2)).not.toContain('gen ');
  });
  it('purity: a deep-frozen state is never mutated and renders identically twice', () => {
    const s = deepFreeze(live({ git: { ...gitMain, ahead: 2 }, jevLatencies: [...JEV12], title: 'fix parse_date tz', toasts: [{ id: 1, text: 'hi', level: 'info', untilMs: 5 }], errors: 2, draft: { secretHits: 1 } }));
    const before = JSON.stringify(s);
    const a = statusLineText(s, 160, spin2);
    const z = statusZones(s, 160, spin2);
    const b = statusLineText(s, 160, spin2);
    expect(a).toBe(b);
    expect(z.right.length).toBeGreaterThan(0);
    expect(JSON.stringify(s)).toBe(before);
    for (const c of [1, 40, 80, 120, 200, 500]) statusLineText(s, c, { ascii: true });
    expect(JSON.stringify(s)).toBe(before);
  });
  it('throughput: 10,000 renders of the rich 120-column row stay well under the 16 ms keystroke budget each', () => {
    const rich = live({ git: { ...gitMain, ahead: 2 }, jevLatencies: JEV12, title: 'fix parse_date tz', runId: 'r' });
    for (let i = 0; i < 200; i++) statusLineText(rich, 120, { spinnerFrame: i });
    const t0 = performance.now();
    const n = 10_000;
    let acc = 0;
    for (let i = 0; i < n; i++) acc += statusLineText(rich, 120, { spinnerFrame: i }).length;
    const ms = performance.now() - t0;
    expect(acc).toBeGreaterThan(0);
    process.stderr.write(`statusLineText: ${n} renders in ${ms.toFixed(1)} ms (${((ms / n) * 1000).toFixed(1)} µs each)\n`);
    expect(ms / n).toBeLessThan(0.5); // 500 µs per render; measured ≈ tens of µs
  });
});
